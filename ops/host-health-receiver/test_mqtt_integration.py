"""Explicit opt-in isolated Linux/Paho/TLS broker acceptance; no production services."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

from receiver import encode, utc


BASE = os.environ.get("HOST_HEALTH_TEST_PYTHON_IMAGE", "one-minihouse-host-health-fixture:local")
RECEIVER_IMAGE = os.environ.get("HOST_HEALTH_TEST_RECEIVER_IMAGE", BASE)
RECEIVER_PROGRAM = "/app/receiver.py" if "HOST_HEALTH_TEST_RECEIVER_IMAGE" in os.environ else "/fixture/receiver.py"
PUBLISH = r'''
import json,sys,time,paho.mqtt.client as m
c=m.Client(m.CallbackAPIVersion.VERSION2,client_id='fixture-publisher-'+str(time.time_ns()),protocol=m.MQTTv5)
c.tls_set(ca_certs='/fixture/server.crt')
connected=[];published=[]
c.on_connect=lambda c,u,f,r,p:connected.append(not r.is_failure)
c.on_publish=lambda c,u,i,r,p:published.append((i,not r.is_failure))
c.connect('broker',8883)
end=time.monotonic()+15
while not connected and time.monotonic()<end:c.loop(.1)
assert connected==[True]
for entry in json.load(open('/fixture/batch.json')):
 info=c.publish('iot/v1/example-site/example-router/host-health',entry['payload'].encode(),qos=1,retain=entry.get('retain',False))
 while not any(i==info.mid for i,_ in published) and time.monotonic()<end:c.loop(.1)
 assert (info.mid,True) in published
c.disconnect();print(json.dumps({'ok':True,'published':len(published)}))
'''


def docker(*arguments, timeout=45, stdin=None):
    result = subprocess.run(["docker", *arguments], input=stdin, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("ISOLATED_DOCKER_COMMAND_FAILED: " + result.stderr.decode(errors="replace")[-500:])
    return result.stdout.decode()


@unittest.skipUnless(os.environ.get("RUN_MQTT_INTEGRATION") == "1", "explicit local Docker integration opt-in")
class MqttIntegration(unittest.TestCase):
    def test_tls_puback_restart_retained_and_replay(self):
        run_id = uuid.uuid4().hex[:12]
        network, volume = "host-health-test-" + run_id, "host-health-data-" + run_id
        fixtures = "host-health-fixture-" + run_id
        broker, receiver, helper = "host-health-broker-" + run_id, "host-health-receiver-" + run_id, "host-health-helper-" + run_id
        created = []
        source = Path(__file__).resolve().parent
        artifacts = source / ".test-artifacts"
        artifacts.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="host-health-fixture-", dir=artifacts) as directory:
            fixture = Path(directory)
            docker("network", "create", network); created.append(("network", network))
            docker("volume", "create", volume); created.append(("volume", volume))
            docker("volume", "create", fixtures); created.append(("volume", fixtures))
            try:
                docker("run", "-d", "--name", helper, "--network", "none", "--user", "0", "--mount", "type=volume,source=" + fixtures + ",target=/fixture", "--mount", "type=volume,source=" + volume + ",target=/app/data", "--entrypoint", "python3", BASE, "-c", "import time;time.sleep(600)")
                created.append(("container", helper))
                docker("exec", helper, "openssl",
                       "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/fixture/server.key", "-out", "/fixture/server.crt", "-days", "1", "-subj", "/CN=broker", "-addext", "subjectAltName=DNS:broker")
                (fixture / "mosquitto.conf").write_text("listener 8883\nallow_anonymous true\ncertfile /fixture/server.crt\nkeyfile /fixture/server.key\n", encoding="utf-8")
                docker("exec", helper, "python3", "-c", "import os;os.chown('/app/data',10001,10001);os.chmod('/app/data',0o700);os.chmod('/fixture/server.key',0o644)")
                config = json.loads((source / "config.example.json").read_text())
                config["mqtt"].update(url="mqtts://broker:8883", client_id="fixture-receiver-" + run_id, password_file="/fixture/password")
                (fixture / "password").write_text("fixture-not-a-production-credential", encoding="utf-8")
                (fixture / "receiver.json").write_text(json.dumps(config), encoding="utf-8")
                for path in [source / "receiver.py", fixture / "mosquitto.conf", fixture / "password", fixture / "receiver.json"]:
                    docker("cp", str(path), helper + ":/fixture/" + path.name)
                docker("run", "-d", "--name", broker, "--network", network, "--network-alias", "broker", "--mount", "type=volume,source=" + fixtures + ",target=/fixture,readonly", "eclipse-mosquitto:2.0", "mosquitto", "-c", "/fixture/mosquitto.conf", timeout=120)
                created.append(("container", broker))
                docker("run", "-d", "--name", receiver, "--network", network, "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "64m", "--pids-limit", "16", "--tmpfs", "/tmp:size=4m", "--env", "SSL_CERT_FILE=/fixture/server.crt", "--env", "PYTHONDONTWRITEBYTECODE=1", "--mount", "type=volume,source=" + fixtures + ",target=/fixture,readonly", "--mount", "type=volume,source=" + volume + ",target=/app/data", "--entrypoint", "python3", RECEIVER_IMAGE, "-B", RECEIVER_PROGRAM, "--config", "/fixture/receiver.json")
                created.append(("container", receiver))
                actual_hash = docker("exec", receiver, "python3", "-c", "import hashlib;print(hashlib.sha256(open('" + RECEIVER_PROGRAM + "','rb').read()).hexdigest())").strip()
                self.assertEqual(actual_hash, hashlib.sha256((source / "receiver.py").read_bytes()).hexdigest())
                def read(name):
                    return json.loads(docker("exec", receiver, "python3", "-c", "from pathlib import Path;print(Path('/app/data/monitor/" + name + "').read_text())"))
                def wait(predicate, timeout=30):
                    until = time.monotonic() + timeout
                    while time.monotonic() < until:
                        try:
                            value = predicate()
                            if value: return value
                        except (RuntimeError, json.JSONDecodeError):
                            pass
                        time.sleep(.25)
                    raise AssertionError("ISOLATED_MQTT_ACCEPTANCE_TIMEOUT")
                wait(lambda: read("health.json")["subscribed"])
                now = time.time(); boot = str(uuid.uuid4())
                def value(sequence, stamp):
                    return {"schema_version":1,"message_id":str(uuid.uuid4()),"site_id":"example-site","host_id":"example-router","boot_id":boot,"sequence":sequence,"read_time_utc":utc(stamp),"uptime_seconds":1000+sequence,"metrics":{"memory_available_bytes":500000000},"conditions":{key:{"state":"good","severity":"warning","incident_id":None,"detail_code":"none"} for key in ("memory_pressure","io_pressure","temperature","storage")},"actions":[]}
                first = value(1, now)
                action = {"event_id":str(uuid.uuid4()),"action_id":str(uuid.uuid4()),"incident_id":str(uuid.uuid4()),"action_time_utc":utc(now),"kind":"restart_proxy","result":"claimed","target_id":"proxy"}
                first["actions"] = [action]
                def publish(entries):
                    (fixture / "batch.json").write_text(json.dumps(entries), encoding="utf-8")
                    docker("cp", str(fixture / "batch.json"), helper + ":/fixture/batch.json")
                    result = json.loads(docker("run", "--rm", "--network", network, "--mount", "type=volume,source=" + fixtures + ",target=/fixture,readonly", "--entrypoint", "python3", BASE, "-B", "-c", PUBLISH))
                    self.assertTrue(result["ok"])
                publish([{"payload":encode(first).decode()}, {"payload":encode(first).decode()}])
                wait(lambda: read("example-router.json")["message_id"] == first["message_id"])
                original = read("example-router.json")
                self.assertEqual(original["payload_sha256"], hashlib.sha256(encode(first)).hexdigest())
                docker("restart", "--timeout", "10", receiver)
                wait(lambda: read("health.json")["subscribed"])
                self.assertEqual(read("example-router.json"), original)
                second = value(2, now + 1); second["actions"] = [dict(action, event_id=str(uuid.uuid4()), action_time_utc=utc(now + 1), result="succeeded")]
                third = value(3, now + 2)
                publish([{"payload":encode(second).decode()}, {"payload":encode(third).decode()}])
                wait(lambda: read("example-router.json")["sequence"] == 3)
                current = read("example-router.json")
                self.assertEqual(len(current["actions"]), 2)
                stale = value(4, now - 600); stale["actions"] = [dict(action, event_id=str(uuid.uuid4()), action_time_utc=utc(now - 1), result="uncertain")]
                retained = value(5, now + 3)
                publish([{"payload":encode(stale).decode()}, {"payload":encode(retained).decode(), "retain":True}])
                wait(lambda: len(read("example-router.json")["actions"]) == 3)
                final = read("example-router.json")
                self.assertEqual(final["message_id"], third["message_id"])
                self.assertEqual(final["receive_time_utc"], current["receive_time_utc"])
                wait(lambda: read("health.json")["counters"].get("rejected",0) >= 1, timeout=15)
                health = read("health.json")
                self.assertEqual(health["counters"]["saved"], 3)
                self.assertEqual(health["counters"]["duplicates"], 1)
                self.assertEqual(health["counters"]["stale"], 1)
                print(json.dumps({"isolated_tls_mqtt":True,"actual_paho":"2.1.0","receiver_source_hash_matches":True,"built_receiver_image":RECEIVER_PROGRAM=="/app/receiver.py","receiver_restarted":True,"saved":3,"duplicates":1,"stale":1,"retained_rejected":True,"actions_preserved":3,"production_services_touched":False}))
            finally:
                for kind, name in reversed(created):
                    subprocess.run(["docker", kind, "rm", "-f", name] if kind=="container" else ["docker", kind, "rm", name], capture_output=True)


if __name__ == "__main__":
    unittest.main()
