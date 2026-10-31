export default {
  id: 9,
  name: 'MySQL (8.4 LTS)',
  category: 'database',
  extension: 'sql',
  source_file: 'query.sql',
  image: 'codebox/mysql:8.4',
  compile_cmd: null,
  run_cmd: 'node /opt/runner/runner.js /box/query.sql',
  default_time_limit: 5,
  max_time_limit: 30,
  min_memory: 0,
  is_archived: false,
};

