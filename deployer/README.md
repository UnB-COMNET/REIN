# Lumi Chatbot Deployer
Lumi Chatbot Intent Deployer


## Citing Lumi
```
@inproceedings{Jacobs2021,
    author = {Arthur S. Jacobs and Ricardo J. Pfitscher and Rafael H. Ribeiro and Ronaldo A. Ferreira and Lisandro Z. Granville and Walter Willinger and Sanjay G. Rao},
    title = {Hey, Lumi! Using Natural Language for Intent-Based Network Management},
    booktitle = {2021 {USENIX} Annual Technical Conference ({USENIX} {ATC} 21)},
    year = {2021},
    isbn = {978-1-939133-23-6},
    pages = {625--639},
    url = {https://www.usenix.org/conference/atc21/presentation/jacobs},
    publisher = {{USENIX} Association},
    month = jul,
}
```
# What it executes
`POST /deploy` takes one Nile intent. `nile.py` checks its syntax (400) and whether this deployer executes it
(422 with the reason); `GET /capabilities` lists every operation and why it runs or not. All of them take
`for endpoint('<client ip>')`:

| Operation | Effect |
|-----------|--------|
| `add service('cdn-qoe')` | Picks the CDN server and the path (`services/cdn_qoe.py`), installs it and hands it to the supervisor |
| `remove service('cdn-qoe')` | Removes the client's path and stops its supervision |
| `set bandwidth('max', '<n>', '<unit>')` | A DROP meter on what reaches the client, at the client's switch (`edge.py`) |
| `block protocol('<p>')` | Drops `tcp`, `udp`, `icmp`, `ssh`, `http` or `https` to and from the client, at its switch (`edge.py`) |
| `unset bandwidth(...)`, `allow protocol(...)` | Remove the policy above |

A client has one policy of each kind: a new limit replaces the previous one. `GET /intents` lists what is in
place and `DELETE /delete_all` removes all of it.

# Running
cd into the deployer's directory.
### Create a .env file with the necessary credentials
```
touch .env
```
Example with ONOS
```
ONOSUSER=<username>
ONOSPASS=<pass>
```
## Docker
### Build the image
```
docker build -t deployer .
```
### Run the container
Make sure the the deploy target is reachable and issue the command


se der erro usar:
sudo docker rm $(sudo docker ps -aq)

em caso de erro de container ainda rodando:
sudo docker stop $(sudo docker ps -aq) 

```
docker run --rm -it --network host --name deployer deployer
```

## Without Docker
Using a virtualenv or not, install the requirements
```
pip install -r requirements.txt
```
Run the server with
```
flask run
```
or
```
python3 app.py
```

