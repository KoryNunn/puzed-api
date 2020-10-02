const finalStream = require('final-stream');
const hint = require('../../modules/hint');

async function githubWebhookEndpointHandler (scope, request, response) {
  const { db } = scope;

  const data = await finalStream(request)
    .then(buffer => buffer.toString('utf8'))
    .then(JSON.parse);

  console.log('Request received');
  console.log('     Host:', request.headers.host);
  console.log('   Method:', request.method);
  console.log('      URL:', request.url);
  console.log('     Data:', data);

  if (data.action === 'deleted') {
    hint('puzed.providers.github.webHook', 'installation deleted requested');
    const links = await db.getAll('SELECT * FROM "links" WHERE "externalUserId" = $1', [data.installation.account.login]);

    const link = links.find(link => link.config.installationId === String(data.installation.id));

    if (link) {
      await db.run('DELETE FROM "links" WHERE "id" = $1', [link.id]);
    } else {
      hint('puzed.providers.github.webHook', 'installation could not be deleted');
    }
  }

  response.end();
}

module.exports = githubWebhookEndpointHandler;
