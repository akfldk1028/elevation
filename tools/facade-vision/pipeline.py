"""Command entry point for source-preserving facade tracing."""
import json
import sys
from trace_runner import main

if __name__ == '__main__':
    try:
        result = main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
    print(json.dumps(result))
    sys.exit(0 if result['ok'] else 1)
