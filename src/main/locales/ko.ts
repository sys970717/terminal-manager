// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/** main 프로세스 한국어 문구 (기준 사전). en.ts 는 같은 키를 모두 가져야 한다 */
export const ko = {
  // 공통
  'common.cancel': '취소',

  // SSH 접속 오류 분류 (sshAuth.classifySshError): "원인. 해결 방법."
  'sshErr.decryptFailed':
    '저장된 비밀번호를 복호화하지 못했습니다(다른 OS 계정/PC에서 만든 데이터이거나 손상됨). 세션을 편집해서 비밀번호를 다시 입력하세요.',
  'sshErr.keyNotFound':
    '키 파일을 찾을 수 없습니다. 세션을 편집해서 PEM 키 경로를 다시 선택하세요.',
  'sshErr.authFailed':
    '인증에 실패했습니다. 계정, 비밀번호 또는 PEM 키가 서버와 맞는지 확인하세요.',
  'sshErr.unreachable':
    '서버에 연결할 수 없습니다. 호스트(IP/도메인)와 포트가 맞는지, 서버가 켜져 있는지 확인하세요.',
  'sshErr.timeout':
    '연결 시간이 초과되었습니다. 네트워크(VPN, 방화벽, 보안그룹)에서 해당 포트가 열려 있는지 확인하세요.',
  'sshErr.passphraseWrong':
    '키 암호(passphrase)가 맞지 않습니다. 암호를 다시 확인해서 다시 연결하세요.',
  'sshErr.other':
    '기타 오류가 발생했습니다. 원문을 확인하고 계정, 호스트, 키 설정을 점검하세요. (원문: {raw})',
  'sshErr.ppkHint':
    'PPK(PuTTY) 키는 지원이 제한적입니다. PuTTYgen → Conversions → Export OpenSSH key 로 .pem 으로 변환해서 다시 지정하세요.',
  'sshErr.decryptError': '저장된 비밀번호를 복호화하지 못했습니다',
  'sshErr.decryptErrorCause': '저장된 비밀번호를 복호화하지 못했습니다: {cause}',

  // 터미널에 찍는 접속 안내/입력 프롬프트 (ssh.ts)
  'ssh.connecting': '{user}@{host}:{port} 접속 중...',
  'ssh.disconnected': '[연결 종료]',
  'ssh.passphrasePrompt': '키 암호(passphrase): ',
  'ssh.passwordPrompt': '{user}@{host} 비밀번호: ',
  'ssh.keyPathEmpty': '키 파일 경로가 비어 있습니다. 세션을 편집해서 PEM 키를 지정하세요.',
  'ssh.shellFailed': '셸을 열 수 없습니다: {message}',
  'ssh.ended': '연결이 종료되었습니다.',
  'ssh.notConnected': '아직 접속되지 않았습니다.',
  'ssh.notConnectedList': '아직 접속되지 않았습니다. 접속이 끝나면 ↻ 새로고침을 눌러 주세요.',

  // 호스트 키 확인 대화상자 (ssh.ts)
  'hostKey.changed.title': '호스트 키가 바뀌었습니다',
  'hostKey.changed.message': '{name} ({host}) 의 호스트 키가 이전과 다릅니다.',
  'hostKey.changed.detail':
    '이전: {old}\n현재: {current}\n\n서버를 재설치했거나 IP가 바뀐 게 아니라면 중간자 공격일 수 있습니다.',
  'hostKey.changed.replace': '새 키로 교체하고 접속',
  'hostKey.new.title': '처음 접속하는 서버',
  'hostKey.new.message': '{name} ({host}) 에 처음 접속합니다.',
  'hostKey.new.detail': '호스트 키 지문: {fp}\n\n신뢰하고 저장할까요?',
  'hostKey.new.accept': '접속하고 저장',

  // known_hosts 저장소 (knownHosts.ts)
  'knownHosts.saveFailed': '지문을 저장하지 못했습니다',
  'knownHosts.fingerprintsLost': '이전 지문이 없어져 이번 지문은 검증할 수 없습니다',

  // SFTP 파일 작업 (ssh.ts, sftpUtil.ts)
  'sftp.badPathChar': '경로에 쓸 수 없는 문자가 있습니다.',
  'sftp.permissionDenied': '권한 없음: {path}',
  'sftp.noSuchFile': '없는 경로: {path}',
  'sftp.nameEmpty': '이름이 비어 있습니다.',
  'sftp.nameInvalid': '쓸 수 없는 이름입니다: {name}',
  'sftp.nameSlash': '이름에 / 는 쓸 수 없습니다.',
  'sftp.nameTooLong': '이름이 너무 깁니다 (255바이트 이하).',
  'sftp.exists': '같은 이름이 이미 있습니다: {name}',
  'sftp.cannotRemove': '이 폴더는 지울 수 없습니다: {path}',
  'sftp.notFolder': '폴더가 아닙니다: {path}',
  'sftp.noDownloadDir': '아직 다운로드한 폴더가 없습니다.',
  'sftp.pickDownloadDir.title': '다운로드할 폴더 고르기',
  'sftp.pickDownloadDir.button': '여기에 저장',
  'sftp.conflict.title': '이미 있는 파일',
  'sftp.conflict.message': '{dir} 에 같은 이름이 이미 있습니다.',
  'sftp.conflict.more': '... 외 {count}개',
  'sftp.conflict.overwrite': '덮어쓰기',

  // 터미널 IPC 입력 검사 (terms.ts)
  'term.uploadSshOnly': '업로드는 연결된 SSH 터미널에서만 가능합니다.',
  'term.listSshOnly': '파일 목록은 연결된 SSH 터미널에서만 볼 수 있습니다.',
  'term.sshOnly': '연결된 SSH 터미널에서만 할 수 있습니다.',
  'term.badFolder': '폴더 값이 올바르지 않습니다.',
  'term.badName': '이름 값이 올바르지 않습니다.',
  'term.badNewName': '새 이름 값이 올바르지 않습니다.',
  'term.badPath': '경로 값이 올바르지 않습니다.',
  'term.noSelection': '고른 항목이 없습니다.',

  // 세션 입력 검증 (validate.ts)
  'validate.invalidInput': '세션 정보가 올바르지 않습니다.',
  'validate.nameRequired': '이름은 필수입니다.',
  'validate.hostRequired': '호스트(IP 또는 도메인)는 필수입니다.',
  'validate.hostInvalid':
    '호스트 형식이 올바르지 않습니다: "{host}". IP 주소나 도메인(예: 10.0.0.5, example.com)을 입력하세요.',
  'validate.portRange': '포트는 1~65535 사이의 정수여야 합니다.',
  'validate.usernameRequired': '계정은 필수입니다.',
  'validate.authType': '인증 방식은 PEM 키 또는 비밀번호 중 하나여야 합니다.',
  'validate.keyPathRequired': 'PEM 키 인증을 쓰려면 키 파일 경로를 선택하세요.',

  // 키 파일 확인 경고 (keyCheck.ts)
  'keyCheck.notFound': '키 파일을 찾을 수 없습니다: {name}',

  // 세션 저장소 (storeCore.ts, sessionStore.ts)
  'store.saveFailed':
    '세션 저장에 실패했습니다. 파일이 다른 프로그램에서 사용 중인지 확인하고 다시 시도하세요. 변경 내용은 반영되지 않았습니다.',
  'store.saveFailedCode':
    '세션 저장에 실패했습니다 ({code}). 파일이 다른 프로그램에서 사용 중인지 확인하고 다시 시도하세요. 변경 내용은 반영되지 않았습니다.',
  'store.encryptionUnavailable':
    '이 PC에서 OS 암호화(Windows DPAPI / macOS 키체인)를 쓸 수 없어 비밀번호/키 암호를 저장하지 않았습니다. 비밀번호 없이 저장하면 접속할 때마다 입력받습니다.',
  'store.sessionNotFound': '세션을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 시도하세요.',
  'store.folderNotFound': '선택한 폴더를 찾을 수 없습니다. 폴더를 다시 선택하세요.',
  'store.folderNameRequired': '폴더 이름을 입력하세요.',
  'store.copyName': '{name} (복사본)',
  'store.corrupt.noSessions': 'sessions 필드가 없습니다',
  'store.corrupt.parseFailed': 'JSON 파싱 실패: {message}',
  'store.corrupt.title': '세션 파일을 읽을 수 없습니다',
  'store.corrupt.message': '세션 파일이 손상되어 빈 목록으로 시작합니다.',
  'store.corrupt.detailBackedUp': '원본은 다음 파일로 백업했습니다:\n{path}\n\n원인: {reason}',
  'store.corrupt.detailNoBackup':
    '원본 백업에도 실패했습니다. 원본 파일을 직접 보관하세요:\n{path}\n\n원인: {reason}',

  // 키 파일 선택 대화상자 (sessionStore.ts)
  'dialog.keyFile.title': 'SSH 개인키 선택',
  'dialog.keyFile.filterKeys': 'SSH 키',
  'dialog.keyFile.filterAll': '모든 파일'
}
