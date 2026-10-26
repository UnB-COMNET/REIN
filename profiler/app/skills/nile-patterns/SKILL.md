---
name: nile-patterns
description: Shape of a Nile intent and its clauses, in the canonical form the deployer parses.
---
Nile intent shape (one line, every value in single quotes):
define intent <name>: <scope> <action> [start <time> end <time>]
- scope: from <target> to <target> | for <target>
- target: endpoint('<ip or name>') | group('<name>') | service('<name>') | traffic('<name>')
- action, several items joined by ", ":
  set|unset bandwidth('max'|'min', '<number>', '<unit>'), quota('upload'|'download', '<number>', '<unit>')
  allow|block traffic('<name>'), service('<name>'), protocol('<name>')
  add|remove middlebox('<name>'), service('<name>')
- time: hour('HH:MM') | date('YYYYMMDD')
Units: 'bps', 'kbps', 'mbps', 'gbps'; quotas per period: 'mb/d', 'gb/d', 'mb/wk', 'gb/wk', 'gb/mth'.
Copy numbers exactly as the request states them; never add a value the request does not give.
Group, traffic, protocol, service and middlebox names come from the request itself (e.g. group('students'),
traffic('torrent')): translate them to English and write them, do not ask for them. Only client IPs, PoPs
and REIN services must come from the inventory. Usual group names: students, professors, faculty, staff,
guests, users, dorms.
