export default {
  id: 7,
  name: "SQL (SQLite 3)",
  is_archived: false,
  source_file: "query.sql",
  compile_cmd: null,
  run_cmd: "sqlite3 -header -column /box/db.sqlite < query.sql",
  image: "codebox/sqlite:3",
};
