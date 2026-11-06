"""Adds each IPv4 address given on the command line to the loopback interface (lo:1, lo:2, ...).

Used by demo.mjs so stub upstreams can answer on the anonymised Caddyfile's 10.0.0.x addresses. Needs root
(CAP_NET_ADMIN); exits 1 if any address cannot be added. Only for throwaway containers and CI runners.
"""
import fcntl
import socket
import struct
import sys

SIOCSIFADDR = 0x8916
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for i, ip in enumerate(sys.argv[1:]):
    try:
        socket.socket().bind((ip, 0))
        continue  # already local
    except OSError:
        pass
    name = f"lo:{i + 1}".encode()
    req = struct.pack("16sH2s4s8s", name, socket.AF_INET, b"\0\0", socket.inet_aton(ip), b"\0" * 8)
    try:
        fcntl.ioctl(s, SIOCSIFADDR, req)
    except OSError as e:
        print(f"loopback-alias: {ip}: {e}", file=sys.stderr)
        sys.exit(1)
