#!/usr/bin/env python3
"""
Example cron script that runs on schedule.
This script will run up to 5 times (as configured in config.yaml).
"""
import sys
import os
from datetime import datetime

def main():
    timestamp = datetime.now().isoformat()
    
    # Get arguments passed from config
    args = sys.argv[1:]
    
    # Get environment variables
    foo_env = os.environ.get('FOO', 'not set')
    
    print(f"=== exampleCron.py executed at {timestamp} ===")
    print(f"Process ID: {os.getpid()}")
    print(f"Arguments received: {args}")
    print(f"FOO environment variable: {foo_env}")
    print("Performing scheduled task...")
    print("Task completed successfully!")
    print("=" * 50)

if __name__ == "__main__":
    main()
