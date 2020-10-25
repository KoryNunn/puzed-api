const finalStream = require('final-stream');
const writeResponse = require('write-response');

const createRandomString = require('../../common/createRandomString');
const authenticate = require('../../common/authenticate');
const presentService = require('../../presenters/service');

const validateService = require('../../validators/service');
const getServiceById = require('../../queries/services/getServiceById');

async function updateService (scope, request, response, tokens) {
  const { db, config } = scope;

  request.setTimeout(60 * 60 * 1000);

  const { user } = await authenticate({ db, config }, request.headers.authorization);

  const service = await getServiceById(scope, user.id, tokens.serviceId);

  if (!service) {
    throw Object.assign(new Error('resource not be found'), {
      statusCode: 404
    });
  }

  const body = await finalStream(request)
    .then(buffer => buffer.toString('utf8'))
    .then(JSON.parse);

  const validationErrors = await validateService(scope, user.id, service, body);

  if (validationErrors) {
    throw Object.assign(new Error('invalid service data'), {
      statusCode: 422,
      message: {
        error: validationErrors
      }
    });
  }

  await db.patch('services', {
    name: body.name,
    linkId: body.linkId,
    providerRepositoryId: body.providerRepositoryId,
    image: body.image,
    webPort: body.webPort,
    networkRulesId: body.networkRulesId,
    domain: body.domain,
    secrets: JSON.stringify(body.secrets),
    environmentVariables: body.environmentVariables,
    runCommand: body.runCommand,
    buildCommand: body.buildCommand,
    dateUpdated: Date.now()
  }, {
    query: {
      id: service.id
    }
  });

  const updatedService = await getServiceById(scope, user.id, tokens.serviceId);

  writeResponse(200, JSON.stringify(presentService(updatedService)), response);
}

module.exports = updateService;
