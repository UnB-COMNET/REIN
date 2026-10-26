#! /bin/bash
export $(cat .env | tr -d '\r' | xargs) && python3 app.py "$@"
