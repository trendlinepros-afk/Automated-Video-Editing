"""AI Video Editor rendering engine.

Run as `python -m ave_engine <command>` with this folder's parent on PYTHONPATH.
Every command prints JSON lines on stdout (see events.py); nothing else goes to stdout.
"""

# Must match ENGINE_VERSION in src/shared/appInfo.ts. Each project records the version it was made with.
VERSION = '1.0.0'
