const http = require('http');
const postgres = require('postgres-fp/promises');

async function livelog ({ db, config }, request, response, tokens) {
  const deployment = await postgres.getOne(db, `
    SELECT "deployments".*
      FROM "deployments"
     WHERE "deployments"."id" = $1
  `, [tokens.deploymentId]);

  const upstreamRequest = http.request({
    socketPath: '/var/run/docker.sock',
    path: `/v1.26/containers/${deployment.dockerId}/logs?stderr=1&stdout=1&timestamps=1&follow=1&tail=10`
  }, function (upstreamResponse) {
    response.writeHead(upstreamResponse.statusCode);
    upstreamResponse.pipe(response);
  });
  upstreamRequest.end();
}

module.exports = livelog;
