const fs = require('fs');
const tls = require('tls');

const Keypairs = require('@root/keypairs');
const ACME = require('@root/acme');
const CSR = require('@root/csr');
const PEM = require('@root/pem');

const mem = require('mem');

const postgres = require('postgres-fp/promises');

const pkg = require('../package.json');
const packageAgent = 'test-' + pkg.name + '/' + pkg.version;

const inProgress = {};

async function createAcmeAccount (acme, email) {
  const accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' });
  const accountKey = accountKeypair.private;

  console.info('registering new ACME account...');

  const account = await acme.accounts.create({
    subscriberEmail: email,
    agreeToTerms: true,
    accountKey
  });

  const acmeAccountPem = await Keypairs.export({ jwk: accountKey });
  await fs.promises.writeFile('./config/acme-account.pem', acmeAccountPem, 'ascii');

  console.info('created account with id', account.key.kid);
}

async function getAcmeAccount (acme, email) {
  try {
    await fs.promises.readFile('./config/acme-account.pem', 'ascii');
  } catch (error) {
    if (error.code === 'ENOENT') {
      await createAcmeAccount(acme, email);
    } else {
      throw error;
    }
  }

  const accountKeyPem = await fs.promises.readFile('./config/acme-account.pem', 'ascii');
  const accountKey = await Keypairs.import({ pem: accountKeyPem });
  const account = await acme.accounts.create({
    subscriberEmail: email,
    agreeToTerms: true,
    accountKey
  });

  console.info('loaded account with id', account.key.kid);

  return { account, accountKey };
}

async function getCertificateForDomain ({ config, db }, domain) {
  // Already in database (success)
  const existingCertificate = await postgres.getOne(db, 'SELECT * FROM certificates WHERE $1 LIKE domain AND status = \'success\'', [domain]);
  if (existingCertificate) {
    return {
      key: existingCertificate.privatekey,
      cert: existingCertificate.fullchain
    };
  }

  // Already in database (pending)
  if (await postgres.getOne(db, 'SELECT * FROM certificates WHERE $1 LIKE domain', [domain])) {
    console.log('acmeUtils: already in database, but not finished');
    return;
  }

  // Already processing
  if (inProgress[domain]) {
    console.log('acmeUtils: already progressing');
    return;
  }
  inProgress[domain] = true;

  const email = config.email;

  const errors = [];
  function notify (ev, msg) {
    if (ev === 'error' || ev === 'warning') {
      errors.push(ev.toUpperCase() + ' ' + msg.message);
      return;
    }
    console.log(ev, msg.altname || '', msg.status || '');
  }

  const acme = ACME.create({ maintainerEmail: email, packageAgent, notify });
  await acme.init(config.directoryUrl);

  const { account, accountKey } = await getAcmeAccount(acme, email);

  // Generate server certificates
  const serverKeypair = await Keypairs.generate({ kty: 'RSA', format: 'jwk' });
  const serverKey = serverKeypair.private;
  const serverPem = await Keypairs.export({ jwk: serverKey });

  const encoding = 'der';
  const typ = 'CERTIFICATE REQUEST';

  const domains = [domain];
  const csrDer = await CSR.csr({ jwk: serverKey, domains, encoding });
  const csr = PEM.packBlock({ type: typ, bytes: csrDer });

  const challenges = {
    'http-01': {
      init: async function () {
        return null;
      },
      set: async function (data) {
        await postgres.insert(db, 'certificates', {
          domain,
          challenge: JSON.stringify(data.challenge),
          token: data.challenge.token,
          status: 'pending'
        });

        return null;
      },
      get: async function (data) {
        const result = await postgres.run(db, 'SELECT challenge FROM certificates WHERE token = $1', [data.challenge.token]);
        return JSON.parse(result.challenge);
      },
      remove: async function (data) {
        await postgres.run(db, 'DELETE FROM certificates WHERE token = $1', [data.challenge.token]);
      }
    }
  };

  console.info('validating domain authorization for ' + domains.join(' '));
  const pems = await acme.certificates.create({
    account,
    accountKey,
    csr,
    domains,
    challenges
  });
  const fullchain = pems.cert + '\n' + pems.chain + '\n';

  await postgres.insert(db, 'certificates', {
    domain,
    status: 'success',
    fullchain,
    privatekey: serverPem
  });

  if (errors.length) {
    console.warn();
    console.warn('[Warning]');
    console.warn('The following warnings and/or errors were encountered:');
    console.warn(errors.join('\n'));
  }
}

function getCertificate ({ config, db }, options) {
  const getCachedCertificates = mem(async function (servername) {
    let certificates;
    if (await options.isAllowedDomain(servername)) {
      certificates = await getCertificateForDomain({ config, db }, servername);
    } else {
      console.log('domain', servername, 'is not allowed a certificate');
    }

    return tls.createSecureContext(certificates || options.defaultCertificates);
  }, { maxAge: 60000 });

  return async (servername, cb) => {
    const ctx = await getCachedCertificates(servername);

    if (cb) {
      cb(null, ctx);
    } else {
      return ctx;
    }
  };
}

async function handleHttpChallenge ({ db, config }, request, response) {
  const certificates = await postgres.getAll(db, 'SELECT * FROM certificates WHERE domain = $1', [request.headers.host]);
  for (const certificate of certificates) {
    const challenge = JSON.parse(certificate.challenge);
    if (!challenge) {
      continue;
    }

    if (challenge.challengeUrl === `http://${request.headers.host}${request.url}`) {
      response.end(challenge.keyAuthorization);
      return true;
    }
  }
  return false;
}

module.exports = {
  getCertificate,
  handleHttpChallenge
};
