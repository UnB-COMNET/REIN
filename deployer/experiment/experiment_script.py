import requests
import time
import urllib
import os

credentials = (os.getenv("ONOSUSER"), os.getenv("ONOSPASS"))
base_url = "http://127.0.0.1:8181/onos/v1"

def make_request(method: str, path: str, data={}, headers={}):
    res = {}
    if data: response = requests.request(method=method, url=base_url+path, auth=credentials, json=data, headers=headers)
    else: response = requests.request(method=method, url=base_url+path, auth=credentials, headers={"Accept": "application/json"})
            
    if response.status_code < 299:
        # Add information fields to response object
        if response.headers.get('Location'):
            res["location"] = response.headers.get('Location')
        if response.content:  
            res["content"] = response.json()
            
        return {
            'status': response.status_code,
            **res
        }
    else:
        print(f"Error occured for request to {path}!")
        print(f"Response status: {response.status_code}")
        print(f"Response: {response.content}")
        # Craft an error message with request and response information
        raise Exception({
            'message': "A request to the ONOS API returned an error code.",
            'request': {
                'method': method,
                'path': path,
            },
            'response': response.json()
        })

# Revoke policies that have already been applied for an intent in case a request fails.
def revoke_policies(policies_list: list):
    deleted = []
    for policy in policies_list:
        # print("Deleting policy:", policy["location"])
        # URL encode the device ID string
        url = policy["location"].split("/")
        url[6] = urllib.parse.quote(url[6])
        url_s = "/" + "/".join(url[5:])
        deleted.append(make_request("DELETE", url_s))
    return deleted

add_middlebox = {
            "appId": "org.onosproject.core",
            "priority": 40000,
            "timeout": 0,
            "isPermanent": "true",
            "deviceId": "",

            "treatment": {
                "instructions": [
                    {
                        "type": "OUTPUT",
                        "port": ""
                    }
                ]
            },

            "selector": {
                "criteria": [
                    {
                        "type": "ETH_TYPE",
                        "ethType": "0x0800"
                    },
                    {
                        "type": "IPV4_SRC",
                        "ip": "192.168.0.0/24"
                    }
                ]
            }
        }


res = make_request("GET", "/hosts")
for node in res["content"]:
    print(f"{node}: {res['content'][node]}")
ref_host = input("Type host ID for middlebox path: ")
middlebox_id = input("Type middlebox ID: ")

print("Running 30 replications for add and remove operations")
add_times = []  # ms
remove_times = []  # ms

middlebox_paths = make_request("GET", f"/paths/{urllib.parse.quote_plus(ref_host)}/{urllib.parse.quote_plus(middlebox_id)}")
responses = []

for i in range(30):
    print(f"Replication #{i+1}")
    print("Installing Flow Rules")
    responses = []  # Reset responses array
    start = time.time()
    for link in middlebox_paths["content"]["paths"][0]["links"]:
        device_id = link["src"].get("device")
        if device_id:
            add_middlebox["deviceId"] = device_id
            add_middlebox["treatment"]["instructions"][0]["port"] = link["src"]["port"]
            responses.append(make_request("POST", f"/flows/{device_id}", data=add_middlebox, headers={'Content-type': 'application/json'}))
    end = time.time()
    add_times.append((end-start) * 10**3)
    
    
    print("Removing Flow Rules")
    start = time.time()
    revoke_policies(responses)
    end = time.time()
    remove_times.append((end-start) * 10**3)


print("Results")
print(f"Add: {add_times}")
print(f"Remove: {remove_times}")
