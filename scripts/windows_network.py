"""User-level TCP links between loopback services and this machine's WSL VM."""
import asyncio
import ipaddress
import subprocess
import sys


async def relay(reader, writer, destination, port):
    upstream = None
    process = None
    try:
        if destination == 'wsl':
            # Some Windows hosts block the WSL virtual adapter. Stdio keeps
            # this local connection independent of privileged firewall rules.
            process = await asyncio.create_subprocess_exec(
                'wsl.exe', '-d', 'Ubuntu', '-u', 'root', '--exec', '/usr/bin/socat',
                'STDIO', f'TCP:127.0.0.1:{port}', stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            incoming, upstream = process.stdout, process.stdin
        else:
            incoming, upstream = await asyncio.wait_for(asyncio.open_connection(destination, port), 10)

        async def copy(source, target):
            while chunk := await source.read(65536):
                target.write(chunk)
                await target.drain()
            if target.can_write_eof():
                target.write_eof()

        await asyncio.gather(copy(reader, upstream), copy(incoming, writer))
    except (ConnectionError, OSError, TimeoutError):
        pass
    finally:
        writer.close()
        if upstream is not None:
            upstream.close()
        if process is not None:
            if process.returncode is None:
                process.terminate()
            await process.wait()


async def main():
    wsl_address, windows_gateway = sys.argv[1:3]
    for address in (wsl_address, windows_gateway):
        if not ipaddress.ip_address(address).is_private:
            raise ValueError('Only private local addresses are supported.')
    listeners = [
        ('127.0.0.1', 3001, 'wsl', 3001),
        ('127.0.0.1', 8317, 'wsl', 8317),
        (windows_gateway, 18000, '127.0.0.1', 8000),
    ]
    servers = []
    for address, port, destination, destination_port in listeners:
        async def connected(reader, writer, dest=destination, target_port=destination_port):
            await relay(reader, writer, dest, target_port)
        servers.append(await asyncio.start_server(connected, address, port))
    print('Seraphine local network ready.', flush=True)
    try:
        await asyncio.gather(*(server.serve_forever() for server in servers))
    finally:
        for server in servers:
            server.close()


if __name__ == '__main__':
    asyncio.run(main())
