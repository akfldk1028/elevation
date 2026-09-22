"""Command entry point for source-preserving facade tracing."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from trace_runner import main

if __name__ == '__main__':
    try:
        result = main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
    print(json.dumps(result))
    sys.exit(0 if result['ok'] else 1)
