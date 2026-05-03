const questionsHandler = require("./questions");

module.exports = async function handler(req, res) {
  return questionsHandler(req, res);
};
