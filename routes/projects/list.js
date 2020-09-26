const writeResponse = require('write-response');

const authenticate = require('../../common/authenticate');
const presentProject = require('../../presenters/project');

async function listProjects ({ db, config }, request, response) {
  const user = await authenticate({ db, config }, request.headers.authorization);

  const projects = await db.getAll(`
    SELECT * FROM "projects" WHERE "userId" = $1
  `, [user.id]);

  writeResponse(200, projects.map(presentProject), response);
}

module.exports = listProjects;
