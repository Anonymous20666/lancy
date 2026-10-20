#!/usr/bin/env python3
"""Run locally on the VPS terminal; never print the session or send credentials to a bot."""
import argparse
import asyncio
import getpass
import os
import re
from pathlib import Path
from dotenv import load_dotenv
from pyrogram import Client

async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('alias', help='lowercase account alias')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9_-]{1,24}', args.alias): parser.error('Use 1–24 lowercase letters, numbers, underscore or hyphen')
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / '.env')
    api_id = os.environ.get('TELEGRAM_API_ID') or input('Telegram API ID: ').strip()
    api_hash = os.environ.get('TELEGRAM_API_HASH') or getpass.getpass('Telegram API hash (hidden): ').strip()
    phone = getpass.getpass('Assistant phone number (hidden): ').strip()
    client = Client(f'lancy_setup_{args.alias}', api_id=int(api_id), api_hash=api_hash, in_memory=True)
    await client.connect()
    try:
        from pyrogram.errors import SessionPasswordNeeded
        sent = await client.send_code(phone)
        code = getpass.getpass('Telegram login code (hidden): ').replace(' ', '')
        try: await client.sign_in(phone, sent.phone_code_hash, code)
        except SessionPasswordNeeded: await client.check_password(getpass.getpass('Telegram 2FA password (hidden): '))
        me = await client.get_me()
        if me.is_bot: raise ValueError('Use a dedicated Telegram USER account, not a bot')
        session = await client.export_session_string()
        data = Path(os.environ.get('DATA_DIR', str(root / 'data'))).resolve()
        inbox = data / 'music-inbox'; inbox.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = inbox / f'{args.alias}.session'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'w') as file: file.write(session)
        print(f'Session staged privately for alias {args.alias}. In the main owner DM use /accounts register {args.alias}.')
        print('Then /accounts allow <alias> <negative-chat-id>. Revoke the account in Telegram Settings > Devices if compromised.')
    finally: await client.disconnect()

if __name__ == '__main__':
    try: asyncio.run(main())
    except Exception as error:
        print(f'Setup failed ({type(error).__name__}). No session value will be printed.')
        raise SystemExit(1)
