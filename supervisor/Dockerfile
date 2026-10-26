FROM python:3.13-slim-bullseye
WORKDIR /supervisor

COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY app/ /supervisor/app/
COPY setup.py /supervisor/setup.py
COPY requirements.txt /supervisor/requirements.txt
COPY .env /supervisor/.env
COPY entrypoint.sh /supervisor/entrypoint.sh
RUN chmod +x /supervisor/entrypoint.sh
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir -e .
EXPOSE 5151
ENTRYPOINT ["/supervisor/entrypoint.sh"]
