#!/usr/bin/env python3
"""User-run once in Alibaba Cloud Shell. Never prints AccessKey secrets.

Without --apply this only displays the exact intended resources and permission.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import traceback
from urllib.parse import unquote

# Synthetic destinations. Configure a private copy before applying.
USER = "example-health-writer"
POLICY = "ExampleHealthWrite"
DOCUMENT = {"Version": "1", "Statement": [{"Effect": "Allow", "Action": ["log:PostLogStoreLogs"],
    "Resource": ["acs:log:cn-hangzhou:*:project/example-minihouse/logstore/server-health"]}]}


def api(action, missing=None, **parameters):
    args = ["aliyun", "ram", action]
    for key, value in parameters.items():
        args.extend(["--" + key, str(value)])
    # Alibaba Cloud Shell can still ship Python 3.6. text/capture_output need 3.7.
    result = subprocess.run(args, universal_newlines=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        match = re.search(r"ErrorCode:\s*([\w.]+)", result.stderr + result.stdout)
        code = match.group(1) if match else "unknown_error"
        if missing and code == missing:
            return None
        # API errors and responses can contain credentials; only a classified code is printed.
        raise RuntimeError(action + ": " + code)
    return json.loads(result.stdout)


def verify_access():
    policies = api("ListPoliciesForUser", UserName=USER)["Policies"]["Policy"]
    if any(p["PolicyName"] != POLICY or p["PolicyType"] != "Custom" for p in policies):
        raise RuntimeError("Unexpected existing permissions; refusing to reuse this user")
    if api("ListGroupsForUser", UserName=USER)["Groups"]["Group"]:
        raise RuntimeError("Unexpected inherited group access")
    if api("GetLoginProfile", missing="EntityNotExist.User.LoginProfile", UserName=USER) is not None:
        raise RuntimeError("Unexpected console login profile")
    return policies


def apply(prepare_only=False):
    os.umask(0o077)
    output = Path.home() / "one-minihouse-server-health-credentials.json"
    if output.exists():
        print("Credential file already exists. No new identity, grant or key was created.")
        print("Download existing file: " + str(output))
        return
    user = api("GetUser", missing="EntityNotExist.User", UserName=USER)
    policy = api("GetPolicy", missing="EntityNotExist.Policy", PolicyType="Custom", PolicyName=POLICY)
    if policy:
        version = api("GetPolicyVersion", PolicyType="Custom", PolicyName=POLICY,
                      VersionId=policy["Policy"]["DefaultVersion"])
        document = version["PolicyVersion"]["PolicyDocument"]
        if isinstance(document, str):
            document = json.loads(unquote(document))
        if document != DOCUMENT:
            raise RuntimeError("Existing policy differs; refusing to change it")
    else:
        api("CreatePolicy", PolicyName=POLICY, PolicyDocument=json.dumps(DOCUMENT),
            Description="oneMiniHouse server-health log upload only")
    if not user:
        api("CreateUser", UserName=USER, DisplayName="oneMiniHouse server health writer")
    policies = verify_access()
    keys = api("ListAccessKeys", UserName=USER)["AccessKeys"]["AccessKey"]
    if keys:
        raise RuntimeError("AccessKey already exists; recover the existing file instead of creating another key")
    if not policies:
        api("AttachPolicyToUser", UserName=USER, PolicyType="Custom", PolicyName=POLICY)
    if prepare_only:
        print("PREPARED: dedicated identity and logstore-only write policy; no AccessKey created.")
        return
    key = api("CreateAccessKey", UserName=USER)["AccessKey"]
    result = {"user_name": USER, "server_id": "example-host", "project": "example-minihouse",
              "logstore": "server-health", "endpoint": "cn-hangzhou.log.aliyuncs.com",
              "access_key_id": key["AccessKeyId"], "access_key_secret": key["AccessKeySecret"]}
    with output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())
    print("READY: dedicated write-only identity and credential file created.")
    print("No console login, log read/delete permission or other application access was granted.")
    print("Credential file: " + str(output))
    print("Next: cloudshell download " + str(output))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--prepare", action="store_true", help="Prepare identity/policy without creating any credential")
    args = parser.parse_args()
    if not args.apply and not args.prepare:
        print(json.dumps({"user": USER, "policy": POLICY, "permission": DOCUMENT,
                          "credential_output": "~/one-minihouse-server-health-credentials.json"}, indent=2))
    else:
        try:
            apply(prepare_only=args.prepare)
        except Exception as error:
            location = traceback.extract_tb(error.__traceback__)[-1]
            reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            print("Stopped: " + reason + " at " + location.name + ":" + str(location.lineno))
            raise SystemExit(1)
