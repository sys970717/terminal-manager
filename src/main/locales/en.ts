// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import type { ko } from './ko'

/** main 프로세스 영어 문구 */
export const en: { [K in keyof typeof ko]: string } = {
  // 공통
  'common.cancel': 'Cancel',

  // SSH 접속 오류 분류
  'sshErr.decryptFailed':
    'Could not decrypt the saved password (it was saved under another OS account or PC, or is corrupted). Edit the session and enter the password again.',
  'sshErr.keyNotFound': 'Key file not found. Edit the session and choose the PEM key path again.',
  'sshErr.authFailed':
    'Authentication failed. Check that the username, password, or PEM key matches the server.',
  'sshErr.unreachable':
    'Cannot reach the server. Check the host (IP/domain) and port, and make sure the server is running.',
  'sshErr.timeout':
    'Connection timed out. Check that the port is open on your network (VPN, firewall, security group).',
  'sshErr.passphraseWrong': 'Wrong key passphrase. Check the passphrase and reconnect.',
  'sshErr.other':
    'Unexpected error. Check the original message and review the username, host, and key settings. (Original: {raw})',
  'sshErr.ppkHint':
    'PPK (PuTTY) keys have limited support. Convert the key to .pem with PuTTYgen → Conversions → Export OpenSSH key, then select it again.',
  'sshErr.decryptError': 'Could not decrypt the saved password',
  'sshErr.decryptErrorCause': 'Could not decrypt the saved password: {cause}',

  // 터미널 출력
  'ssh.connecting': 'Connecting to {user}@{host}:{port}...',
  'ssh.disconnected': '[Disconnected]',
  'ssh.passphrasePrompt': 'Key passphrase: ',
  'ssh.passwordPrompt': "{user}@{host}'s password: ",
  'ssh.keyPathEmpty': 'Key file path is empty. Edit the session and choose a PEM key.',
  'ssh.shellFailed': 'Could not open a shell: {message}',
  'ssh.ended': 'The connection was closed.',
  'ssh.notConnected': 'Not connected yet.',
  'ssh.notConnectedList': 'Not connected yet. Click ↻ Refresh once the connection is ready.',

  // 호스트 키 확인
  'hostKey.changed.title': 'Host key changed',
  'hostKey.changed.message': 'The host key for {name} ({host}) has changed.',
  'hostKey.changed.detail':
    'Previous: {old}\nCurrent: {current}\n\nUnless the server was reinstalled or its IP changed, this could be a man-in-the-middle attack.',
  'hostKey.changed.replace': 'Replace key and connect',
  'hostKey.new.title': 'First connection to this server',
  'hostKey.new.message': 'Connecting to {name} ({host}) for the first time.',
  'hostKey.new.detail': 'Host key fingerprint: {fp}\n\nTrust this host and save its key?',
  'hostKey.new.accept': 'Connect and save',

  // known_hosts
  'knownHosts.saveFailed': 'Could not save the host key fingerprint',
  'knownHosts.fingerprintsLost':
    'Previously saved fingerprints were lost, so this fingerprint cannot be verified',

  // SFTP
  'sftp.badPathChar': 'The path contains an invalid character.',
  'sftp.permissionDenied': 'Permission denied: {path}',
  'sftp.noSuchFile': 'No such file or folder: {path}',
  'sftp.nameEmpty': 'Name is empty.',
  'sftp.nameInvalid': 'Invalid name: {name}',
  'sftp.nameSlash': 'Names cannot contain "/".',
  'sftp.nameTooLong': 'Name is too long (255 bytes max).',
  'sftp.exists': 'An item with this name already exists: {name}',
  'sftp.cannotRemove': 'This folder cannot be deleted: {path}',
  'sftp.notFolder': 'Not a folder: {path}',
  'sftp.noDownloadDir': 'Nothing has been downloaded yet.',
  'sftp.pickDownloadDir.title': 'Choose a download folder',
  'sftp.pickDownloadDir.button': 'Save here',
  'sftp.conflict.title': 'Files already exist',
  'sftp.conflict.message': 'Items with the same name already exist in {dir}.',
  'sftp.conflict.more': '...and {count} more',
  'sftp.conflict.overwrite': 'Overwrite',

  // 터미널 IPC 입력 검사
  'term.uploadSshOnly': 'Upload is only available in a connected SSH terminal.',
  'term.listSshOnly': 'The file list is only available in a connected SSH terminal.',
  'term.sshOnly': 'Only available in a connected SSH terminal.',
  'term.badFolder': 'Invalid folder value.',
  'term.badName': 'Invalid name value.',
  'term.badNewName': 'Invalid new name value.',
  'term.badPath': 'Invalid path value.',
  'term.noSelection': 'Nothing is selected.',

  // 세션 입력 검증
  'validate.invalidInput': 'Invalid session data.',
  'validate.nameRequired': 'Name is required.',
  'validate.hostRequired': 'Host (IP or domain) is required.',
  'validate.hostInvalid':
    'Invalid host format: "{host}". Enter an IP address or domain (e.g. 10.0.0.5, example.com).',
  'validate.portRange': 'Port must be a whole number from 1 to 65535.',
  'validate.usernameRequired': 'Username is required.',
  'validate.authType': 'Authentication method must be PEM key or password.',
  'validate.keyPathRequired': 'Choose a key file to use PEM key authentication.',

  // 키 파일 확인
  'keyCheck.notFound': 'Key file not found: {name}',

  // 세션 저장소
  'store.saveFailed':
    'Could not save the session. Make sure the file is not in use by another program and try again. Your changes were not applied.',
  'store.saveFailedCode':
    'Could not save the session ({code}). Make sure the file is not in use by another program and try again. Your changes were not applied.',
  'store.encryptionUnavailable':
    'OS encryption (Windows DPAPI / macOS Keychain) is not available on this computer, so the password/passphrase was not saved. If you save without a password, you will be asked for it each time you connect.',
  'store.sessionNotFound': 'Session not found. Refresh the list and try again.',
  'store.folderNotFound': 'The selected folder was not found. Choose the folder again.',
  'store.folderNameRequired': 'Enter a folder name.',
  'store.copyName': '{name} (copy)',
  'store.corrupt.noSessions': 'the "sessions" field is missing',
  'store.corrupt.parseFailed': 'JSON parse error: {message}',
  'store.corrupt.title': 'Cannot read the session file',
  'store.corrupt.message': 'The session file is corrupted. Starting with an empty list.',
  'store.corrupt.detailBackedUp': 'The original was backed up to:\n{path}\n\nCause: {reason}',
  'store.corrupt.detailNoBackup':
    'Backing up the original also failed. Keep a copy of the original file yourself:\n{path}\n\nCause: {reason}',

  // 키 파일 선택 대화상자
  'dialog.keyFile.title': 'Select SSH private key',
  'dialog.keyFile.filterKeys': 'SSH keys',
  'dialog.keyFile.filterAll': 'All files'
}
