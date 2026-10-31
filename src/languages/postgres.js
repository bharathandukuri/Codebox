export default {
  id: 8,
  name: "PostgreSQL 16",
  is_archived: false,
  source_file: "query.sql",
  compile_cmd: null,
  run_cmd: "node /opt/runner/runner.js /box/query.sql",
  image: "codebox/postgres:16",
};

