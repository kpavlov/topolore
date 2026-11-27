# Event log format

A recording is a UTF-8 `.jsonl` file: one JSON object per line. Blank lines and lines beginning with `//` are ignored. Open a recording through **Open → Files**, drop it on the current topology, or connect a URL ending in `.jsonl`. You can select the topology and recording together. Nothing is uploaded by the file picker.

## Time

Use `at` for an ISO timestamp or `t` for seconds since the recording starts. Give at most one on a line. Times must be in chronological order. A line with no time runs at the previous line's time, or at zero if it is first. An `at` value without an offset is UTC; `Z` and offsets such as `+02:00` are accepted. Absolute times are displayed in UTC. Playback starts at the first time and stops at the end. The timeline supports seeking, rewind and speed changes. **Dynamic**, enabled by default, spaces nearby events during playback; choose a fixed speed before Dynamic to set its maximum. Seeking applies all events through the selected time.

```jsonl
{"at":"2026-05-06T06:45:00Z","type":"node","id":"api","state":"degraded","message":"Error rate rising"}
{"at":"2026-05-06T08:51:00+00:00","type":"node","id":"api","state":"ok","message":"Recovered"}
```

Alternatively, use relative time:

```jsonl
{"t":0,"type":"node","id":"web","metrics":{"replicas":12}}
{"t":20,"type":"node","id":"web","metrics":{"replicas":30},"message":"Scaled up"}
```

## Updates

Updates apply in order. IDs must refer to the loaded topology or to earlier updates. Invalid recordings are rejected before playback.

| Type | Purpose | Example |
| --- | --- | --- |
| `node` | Update a node; an unknown ID with `kind` adds one. | `{"type":"node","id":"worker-2","kind":"aws.ec2","parent":"vpc"}` |
| `edge` | Update a link by `id`, or add one with existing `from` and `to` nodes. The default ID is `from->to`. | `{"type":"edge","from":"api","to":"worker-2","rps":200}` |
| `group` | Add or update a container; `parent` names another group. | `{"type":"group","id":"vpc","label":"VPC","kind":"aws.vpc"}` |
| `remove` | Remove a node, empty group, or edge. Removing a node also removes its links. | `{"type":"remove","id":"api->worker-1","message":"Traffic moved"}` |
| `snapshot` | Replace the supplied topology arrays (`nodes`, `edges`, `groups`); omitted arrays are retained. | `{"type":"snapshot","nodes":[],"edges":[],"groups":[]}` |

Node states are `ok`, `degraded`, `down`, `fire`, and `unknown`; edge states are `ok`, `slow`, `broken`, and `idle`. A `message` describes an event. Node `metrics` are merged with existing metrics; edge fields such as `rps`, `latencyMs`, `errorRate`, and `speed` update traffic. To switch a path, remove the old edge and add a new one. Existing edge endpoints cannot be changed in place.

## Capacity and instance details

Set `replicas`, `instances`, `instance_type`, `autoscaling_group`, `min_size`, and `max_size` in a node's `props` in JSON, or as node attributes in Topolore HCL. The topology displays the values when present. `replicas` represents pods; `instances` represents machines. Camel-case `instanceType`, `autoScalingGroup`, `minSize`, `maxSize` and `desiredCapacity` and Terraform-style `desired_capacity` are also accepted.

Use numeric `metrics.replicas` and `metrics.instances` in events to update the displayed counts without replacing other properties. Counts in metrics override source properties. For example:

```jsonl
{"t":5,"type":"node","id":"web","metrics":{"replicas":18},"message":"HPA scales up"}
{"t":6,"type":"node","id":"pool","metrics":{"instances":10},"message":"Worker pool scales up"}
```

An event's `props` replaces the node's previous `props`; include all properties you want to retain. A new node needs a `kind` and, if placed inside a container, an existing group as `parent`. Rewinding reconstructs the topology and capacity from the state at the start of the recording.

The bundled [retail recording](../samples/platform.jsonl) contains a fictional scaling example. The [GitHub Actions incident](../samples/github-actions-incident.jsonl) depicts the reported recovery using a schematic node; it does not assert unreported runner counts or instance sizes.
