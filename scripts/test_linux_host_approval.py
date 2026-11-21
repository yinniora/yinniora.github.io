import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class LinuxHostApproval(unittest.TestCase):
    def run_approval(self, *arguments, **options):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixtures = {
                "id": 'printf "1000\\n"\n',
                "loginctl": '''
case "$1:$2" in
    show-user:1000) echo seatA ;;
    show-session:self) exit 1 ;;
    show-session:seatA)
        cat <<EOF
Active=${ACTIVE:-yes}
Remote=${REMOTE:-no}
LockedHint=${LOCKED:-no}
Seat=seat0
Class=user
Type=${TYPE:-wayland}
User=1000
Leader=123
EOF
        ;;
    *) exit 1 ;;
esac
''',
                "pkcheck": '''
test "$1" = --action-id &&
test "$2" = "$EXPECTED_ACTION" &&
test "$3" = --process &&
test "$4" = "${EXPECTED_PID:-123},98765,1000" &&
test "$5" = --allow-user-interaction &&
test "${CANCELLED:-no}" = no
''',
                "stat": '''
case "$3" in
    /proc/123) printf '%s\\n' "${LEADER_UID:-1000}" ;;
    /proc/456) echo 1000 ;;
    *) exit 1 ;;
esac
''',
                "systemctl": "echo /user.slice/user-1000.slice/session-seatA.scope\n",
            }
            for name, body in fixtures.items():
                command = root / name
                command.write_text("#!/bin/sh\n" + body)
                command.chmod(0o700)
            for pid in ("123", "456"):
                stat = root / pid / "stat"
                stat.parent.mkdir()
                stat.write_text(
                    pid + " (desktop (session)) " + " ".join(["S"] + ["0"] * 18 + ["98765"]) + "\n"
                )
            scope = root / "user.slice" / "user-1000.slice" / "session-seatA.scope"
            scope.mkdir(parents=True)
            (scope / "cgroup.procs").write_text("123\n456\n")
            source = Path(__file__).with_name("approve-host-linux").read_text()
            for name in fixtures:
                source = source.replace("/usr/bin/" + name, str(root / name))
            path = root / "approve-device"
            path.write_text(
                source.replace("/proc/$subject/stat", str(root / "$subject" / "stat"))
                .replace("/sys/fs/cgroup$group/cgroup.procs", str(root) + "$group/cgroup.procs")
            )
            return subprocess.run(
                ["/bin/sh", str(path), *arguments],
                env={"PATH": os.defpath, "EXPECTED_ACTION": "org.yugopi.approve-pairing", **options},
                capture_output=True,
                text=True,
                check=False,
            )

    def test_local_device_and_relay_use_fresh_system_authentication(self):
        for arguments, action in (
            (["Phone"], "org.yugopi.approve-pairing"),
            (["--remote-server", "relay.example"], "org.yugopi.configure-remote"),
        ):
            with self.subTest(arguments=arguments):
                approved = self.run_approval(*arguments, EXPECTED_ACTION=action)
                self.assertEqual((approved.returncode, approved.stdout), (0, "approved\n"))

    def test_uses_an_owned_process_when_the_display_manager_owns_the_leader(self):
        approved = self.run_approval("Phone", LEADER_UID="0", EXPECTED_PID="456")
        self.assertEqual((approved.returncode, approved.stdout), (0, "approved\n"))

    def test_denies_remote_locked_inactive_headless_and_canceled_requests(self):
        for flags in (
            {"REMOTE": "yes"},
            {"LOCKED": "yes"},
            {"ACTIVE": "no"},
            {"TYPE": "tty"},
            {"CANCELLED": "yes"},
        ):
            with self.subTest(flags=flags):
                rejected = self.run_approval("Phone", **flags)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(rejected.stdout, "")
