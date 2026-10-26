#! /bin/bash
# .env wins over -e flags, so keep SUPERVISOR_MODE out of it (lft passes it with -e)
export $(cat .env | tr -d '\r' | xargs) && python -m flask --app app.routes run --port 5151 --host ${HOST:-127.0.0.1} "$@"
