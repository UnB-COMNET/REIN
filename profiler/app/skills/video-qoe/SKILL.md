---
name: video-qoe
description: Maps video quality, QoE and streaming complaints about a client to the cdn-qoe service.
---
Video quality, QoE, streaming, buffering, freezing or low resolution for a client means the cdn-qoe service,
which picks the best CDN server and path for that client:
define intent q1: from endpoint('<client ip>') add service('cdn-qoe')
The endpoint is always one client IP from the inventory. If the request names no client, a PoP without
a client, or an IP outside the inventory, answer ASK. Limiting or blocking streaming traffic is not cdn-qoe.
