// restore-os-users.js — replay the snapshotted login user database at boot.
//
// `/etc` is container-local: a recreate wipes every login user and password
// while the homes survive on the volume (and fresh uid numbering then shows
// other members' names on your files). The server snapshots
// `passwd`/`shadow`/`group`/`gshadow` to `<MORSE_HOME>/os-users` after every
// mutation; this script runs as root before sshd and the server start and
// brings the same names back with the same uids, gids and password hashes.
//
// Only login users are replayed (store uid >= 1000, home under `/home/`,
// never `morse`/`root`): system users always come from the image. Missing
// snapshot or disabled OS users → silent success, first boot behaves as
// before. Plain node (full builtins): the ezx bootstrap `require("ezx")`
// runtime has no file read, so this runs as a blocking child instead.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')}: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  }
}

function lines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function upsert(file, key, line) {
  const current = lines(file);
  const kept = current.filter((entry) => entry.split(':')[0] !== key);
  kept.push(line);
  fs.writeFileSync(file, `${kept.join('\n')}\n`);
}

function main() {
  const home = process.env.MORSE_HOME;
  if (!home) {
    return;
  }
  const store = path.join(home, 'os-users');
  const needed = ['passwd', 'shadow', 'group', 'gshadow'];
  if (!needed.every((file) => fs.existsSync(path.join(store, file)))) {
    console.log('restore-os-users: no snapshot yet, skipping');
    return;
  }
  const liveUsers = new Set(lines('/etc/passwd').map((line) => line.split(':')[0]));
  const liveGroups = new Map(lines('/etc/group').map((line) => line.split(':')));
  const storePasswd = lines(path.join(store, 'passwd'));
  const storeShadow = new Map(lines(path.join(store, 'shadow')).map((line) => [line.split(':')[0], line]));
  const storeGshadow = new Map(lines(path.join(store, 'gshadow')).map((line) => [line.split(':')[0], line]));

  // The sudo target set every login shell runs under; name-based, so an
  // image-rebuild gid drift is harmless — only existence matters.
  if (!liveGroups.has('workspace-users')) {
    run('/usr/sbin/groupadd', ['-r', 'workspace-users']);
  }

  let restored = 0;
  for (const entry of storePasswd) {
    const [name, , uidRaw, gidRaw, , userHome, shell] = entry.split(':');
    const uid = Number(uidRaw);
    if (
      name === 'morse' ||
      name === 'root' ||
      liveUsers.has(name) ||
      !Number.isInteger(uid) ||
      uid < 1000 ||
      !(userHome ?? '').startsWith('/home/')
    ) {
      continue;
    }
    const gid = Number(gidRaw);
    if (!liveGroups.has(name)) {
      try {
        run('/usr/sbin/groupadd', ['-g', String(gid), name]);
      } catch {
        run('/usr/sbin/groupadd', [name]);
      }
    }
    run('/usr/sbin/useradd', [
      '-M',
      '-u',
      String(uid),
      '-g',
      name,
      '-G',
      'workspace-users',
      '-s',
      shell || '/bin/zsh',
      '-d',
      userHome,
      name,
    ]);
    const shadow = storeShadow.get(name);
    if (shadow !== undefined) {
      upsert('/etc/shadow', name, shadow);
    }
    const gshadow = storeGshadow.get(name);
    if (gshadow !== undefined) {
      upsert('/etc/gshadow', name, gshadow);
    }
    liveUsers.add(name);
    restored += 1;
  }
  console.log(`restore-os-users: replayed ${restored} login user(s)`);
}

try {
  main();
} catch (error) {
  // Boot must never fail because a login could not be replayed: the server
  // recreates missing users on next web login (password reset needed only
  // for those). Loud on stderr, exit zero.
  console.error(`restore-os-users: ${error instanceof Error ? error.message : String(error)}`);
}
