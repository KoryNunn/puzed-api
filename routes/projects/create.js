const { promisify } = require('util');

const uuidv4 = require('uuid').v4;
const finalStream = promisify(require('final-stream'));
const axios = require('axios');
const postgres = require('postgres-fp/promises');
const NodeRSA = require('node-rsa');

const authenticate = require('../../common/authenticate');
const getLatestCommitHash = require('../../common/getLatestCommitHash');

const presentProject = require('../../presenters/project');

async function ensureDeployKeyOnProject ({ db, config }, owner, repo, authorization) {
  const deployKey = await postgres.getOne(db, `
    SELECT * FROM "githubDeploymentKeys" WHERE "owner" = $1 AND "repo" = $2
  `, [owner, repo]);

  if (!deployKey) {
    const key = new NodeRSA({ b: 2048 }, 'openssh');

    const publicKey = key.exportKey('openssh-public');
    const privateKey = key.exportKey('openssh');

    const creationResponse = await axios({
      url: `${config.githubApiUrl}/repos/${owner}/${repo}/keys`,
      method: 'post',
      headers: {
        authorization
      },
      data: JSON.stringify({
        key: publicKey.trim()
      })
    });

    await postgres.insert(db, 'githubDeploymentKeys', {
      id: uuidv4(),
      githubKeyId: creationResponse.data.id,
      owner,
      repo,
      publicKey,
      privateKey
    });

    return;
  }

  await axios({
    url: `${config.githubApiUrl}/repos/${owner}/${repo}/keys/${deployKey.githubKeyId}`,
    headers: {
      authorization
    }
  }).catch(error => {
    if (error.response.status === 404) {
      return postgres.run(db, 'DELETE FROM "githubDeploymentKeys" WHERE "id" = $1', [deployKey.id])
        .then(() => ensureDeployKeyOnProject({ db, config }, owner, repo, authorization));
    }

    console.log(error);
  });
}

async function createProject ({ db, config }, request, response) {
  request.setTimeout(60 * 60 * 1000);

  const user = await authenticate({ db, config }, request.headers.authorization);

  if (!user.allowedProjectCreate) {
    response.writeHead(403);
    response.end('no permission to create projects');
    return;
  }

  const body = await finalStream(request, JSON.parse);

  if (config.domains.api.includes(body.domain)) {
    throw Object.assign(new Error('Validation error'), {
      statusCode: 422,
      body: {
        errors: [`domain of "${body.domain}" is already taken`]
      }
    });
  }

  if (config.domains.client.includes(body.domain)) {
    throw Object.assign(new Error('Validation error'), {
      statusCode: 422,
      body: {
        errors: [`domain of "${body.domain}" is already taken`]
      }
    });
  }

  const projectId = uuidv4();

  await postgres.insert(db, 'projects', {
    id: projectId,
    name: body.name,
    image: body.image,
    webPort: body.webPort,
    domain: body.domain,
    secrets: JSON.stringify(body.secrets),
    environmentVariables: body.environmentVariables,
    owner: body.owner,
    repo: body.repo,
    runCommand: body.runCommand,
    buildCommand: body.buildCommand,
    userId: user.id,
    dateCreated: Date.now()
  });

  const project = await postgres.getOne(db, `
    SELECT * FROM projects WHERE id = $1
  `, [projectId]);

  response.statusCode = 200;
  response.write(JSON.stringify(presentProject(project), response));

  await ensureDeployKeyOnProject({ db, config }, body.owner, body.repo, request.headers.authorization);

  const latestCommitHash = await getLatestCommitHash({ db, config }, project);

  await postgres.run(db, `
    UPDATE "projects"
    SET "commitHashProduction" = $2
    WHERE "id" = $1
  `, [project.id, latestCommitHash]);
  project.commitHashProduction = latestCommitHash;

  response.end();
}

module.exports = createProject;
