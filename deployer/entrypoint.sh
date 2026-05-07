#! /bin/bash
export $(cat .env | xargs) && python3 app.py
