# Codex CLI 설정과 계정 인증 분리 분석

작성일: 2026-09-13

목적: 계정이 바뀌어도 같은 세션의 스킬·MCP·지침·승인 정책을 유지할 구조를 결정하기 위한 소스 분석.

## 1. 결론

**계정을 설정 프로필처럼 취급하지 않는다.** 사용자 공통 환경과 프로젝트별 환경을 유지하고, 모델 요청을 처리하는 계정 인증을 별도 관리한다. 계정마다 `CODEX_HOME` 전체를 바꾸는 단순 구현은 채택하지 않는 방향이 적절하다.

소스에서 설정과 외부 인증을 분리할 경로는 확인했다. 그러나 App Server 외부 인증은 설치된 CLI의 스키마에도 내부용·불안정 인터페이스로 명시되어 있다. 또한 공통 AuthManager를 쓰므로 서버 하나에서 인증을 변경하는 동작을 특정 세션만의 전환으로 가정할 수 없다.

따라서 제품 원칙과 기술 선택을 구분한다. **동일 세션의 환경 유지가 제품 원칙**이며, 로컬 프록시와 외부 인증 방식 중 실제 경로는 통합 검증 후 결정한다. 이 분석만으로 계정 간 무중단 복구를 구현했다고 주장하지 않는다.

## 2. 확보한 소스와 검증 범위

공식 저장소 `https://github.com/openai/codex.git`를 [refs/codex](refs/codex)에 얕은 클론으로 확보했다. 최초 main HEAD는 `b979d4f1f04538ba5a5fcc434d499c007bfe1b8c`다. 이후 설치 CLI의 버전 표기 `codex-cli 0.154.0`에 맞춰 `rust-v0.154.0`을 fetch하고 detached HEAD로 체크아웃했다. 분석 기준 커밋은 `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`다.

이전 조사 문서가 기록한 동일 이름 태그의 커밋과 이번 fetch 결과가 다르므로, 이전 기록을 덮어쓰거나 같은 소스라고 간주하지 않는다. 이 차이의 원인은 이번 조사에서 규명하지 않았다. 버전 문자열 일치만으로 설치 바이너리가 이 커밋에서 빌드되었다고 증명할 수 없다. 아래에서는 현재 클론의 소스 관찰과 설치 바이너리의 스키마 관찰을 구분한다.

실제 계정 인증 파일·사용자 설정 파일은 읽거나 변경하지 않았다. 설치 바이너리로 실행한 검증은 `--version`, 스키마 생성 명령의 도움말, `app-server generate-json-schema --experimental`이다. 생성 결과는 [config-auth-verification/schema](config-auth-verification/schema)에 보존했다. 소스 테스트는 읽었으며 Rust 테스트를 실행하지 않았다.

## 3. 설정은 어디에서 결정되는가

| 대상 | 관찰한 구조 | 앱 설계에 주는 의미 |
|---|---|---|
| 사용자 설정 | 설정 로더는 `$CODEX_HOME/config.toml`과 선택한 프로필 파일을 읽는다. | 홈을 계정마다 바꾸면 같은 사용자 설정을 읽는다는 보장이 사라진다. |
| 프로젝트 설정 | 작업 경로·프로젝트 루트·신뢰 상태에 따라 프로젝트 설정 계층을 읽는다. | 계정 전환 중 작업 디렉터리와 프로젝트 신뢰 의미를 유지해야 한다. 서로 다른 프로젝트의 설정까지 통일한다는 뜻은 아니다. |
| 스킬 | 사용자 설정 폴더의 `skills`, 사용자 홈의 `.agents/skills`, 프로젝트 설정 폴더의 `skills`, 프로젝트 경로의 `.agents/skills`, 시스템 스킬 등의 탐색 경로가 있다. | `config.toml` 하나를 복사하는 것만으로 같은 스킬 환경을 재현할 수 없다. |
| 전역 지침 | Codex 홈에서 `AGENTS.override.md`, `AGENTS.md` 순서로 확인한다. | 인증 전환과 함께 홈을 바꾸면 전역 지침도 달라질 수 있다. |
| MCP와 권한 설정 | `ConfigToml`에 `mcp_servers`, `approval_policy`, `sandbox_mode` 등이 있으며 설정 계층에서 해석된다. | 설정과 정책은 계정 풀의 속성으로 저장하지 않는다. 사용자·프로젝트의 선택을 존중한다. |
| MCP OAuth | 별도 MCP 인증 저장 로직이 있고 파일 대체 저장소는 `CODEX_HOME/.credentials.json`이다. | Codex 계정 인증과 도구 인증은 별개다. 홈을 바꾸면 MCP 구성은 같아도 도구 로그인이 끊길 수 있다. |
| Codex 인증 | 파일 저장 경로는 `$CODEX_HOME/auth.json`이며 keyring·ephemeral 저장 경로도 있다. | 인증 파일 교체와 설정 홈 교체는 같은 작업이 아니다. 병렬 세션에 공유 인증 파일을 덮어쓰는 방식도 별도 검증 없이 사용하지 않는다. |

설정 로더에는 시스템·클라우드 관리 계층·사용자·프로젝트·런타임 설정과 별도 요구사항 처리가 있다. 위 표는 주요 의존성 설명이지 모든 우선순위를 단순화한 완전한 명세가 아니다. 승인 정책을 런타임 인자로 임의 덮어써서 환경을 통일하는 방식을 권하지 않는다.

## 4. 외부 인증은 설정 분리의 근거지만 제약이 있다

App Server의 `account/login/start`에는 `chatgptAuthTokens` 방식이 있다. access token·계정 ID를 받아 `ExternalAuthBridge`를 설치한다. 인증 갱신이 필요하면 `account/chatgptAuthTokens/refresh`를 클라이언트에 요청한다. 소스의 브리지는 Unauthorized 사유를 전달하며 응답 대기 제한은 10초다. 이 경로를 모든 usage limit·capacity 장애의 자동 복구 인터페이스로 확대 해석하면 안 된다.

설치 바이너리가 생성한 [LoginAccountParams 스키마](config-auth-verification/schema/v2/LoginAccountParams.json)는 이 방식에 다음 설명을 붙인다.

> [UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE.

따라서 ‘공식 CLI에 코드가 있다’와 ‘외부 앱을 위한 안정된 공개 계약이다’는 구분해야 한다. 채택 시 버전 고정·호환성 검증·대체 경로가 필요한 후보이며, 아직 기본 구조로 확정하지 않았다.

현재 소스의 `commit_external_auth`는 외부 ChatGPT 인증을 ephemeral 저장소와 캐시에 반영한다. `ThreadManager`는 공통 `Arc<AuthManager>`를 가지고 새 스레드에도 전달한다. **하나의 App Server에서 인증을 바꾸면 한 스레드만 바뀐다고 가정할 수 없다.** 동일 세션을 여러 UI 탭에 보여주는 것과 인증 관리자 개수를 늘리는 것은 별개의 문제다.

소스에는 외부 인증의 401 갱신 성공, 갱신 오류 시 턴 실패, 허용 워크스페이스 제약 위반 시 턴 실패 테스트가 있다. 마지막 테스트는 명시적인 `forced_workspace_id`가 있는 사례이므로 모든 계정 변경이 금지된다고 일반화하지 않는다.

## 5. 계정과 무관한 환경, 계정에 종속된 서비스

로컬 스킬·지침·직접 구성한 MCP와 승인 정책은 사용자·프로젝트 환경으로 관리할 수 있다. 반면 ChatGPT 계정에 연결된 Apps·커넥터, 조직에서 공급하는 클라우드 정책이나 사용 권한은 인증 계정과 연결될 수 있다. 소스는 로그인 시 클라우드 설정 로더를 교체하며 Apps 목록의 외부 인증 테스트도 포함한다.

따라서 목표는 ‘모든 계정이 같은 서비스를 가진다고 가장하기’가 아니다. **앱이 계정 전환을 이유로 로컬 환경을 바꾸지 않고, 작업에 필요한 계정 종속 기능을 쓸 수 없는 계정은 전환 후보에서 제외하거나 제약을 알리는 것**이 현재 설계 제안이다. 필요한 기능을 어떻게 판정할지는 미결정이다.

## 6. 구현 후보 비교

| 후보 | 얻는 것 | 남는 문제 | 판단 |
|---|---|---|---|
| 계정마다 홈 전체를 교체 | 파일 기반 계정 구분이 단순함 | 설정·지침·스킬·MCP 인증이 함께 달라짐. 동기화 누락과 경로 차이 발생 가능 | 요구를 만족하지 못하는 기본 구현이므로 피한다. |
| 세션 실행별 인증 경계 + 공통 환경 + App Server 외부 인증 | 설정을 유지하며 프로세스 내부 인증을 공급할 수 있는 근거가 있음 | 내부용 인터페이스, 공통 AuthManager 범위, 수십 개 서버 비용, 공용 홈 쓰기 경합을 검증해야 함 | 기술 실험 후보. 프로세스는 패널이 아니라 실제 세션 기준으로 검토한다. |
| 공통 환경 + 로컬 프록시 + 앱 소유 계정 저장소 | 모델 요청의 인증·선택·갱신을 CLI 설정에서 분리할 수 있는 설계 | 실제 세션별 라우팅 식별, 재시도 안전성, WebSocket·HTTP 호환성, CLI가 보는 계정 정보와 실제 요청 계정의 일치 문제 | 우선 검증할 설계 후보. 프록시 채택 자체는 미확정이다. |

`openai_base_url`은 내장 openai 모델 공급자의 URL 재지정 설정으로 존재한다. 이 사실만으로 모델 요청 외 모든 계정 종속 호출까지 프록시를 통과한다고 볼 수 없다. 상태를 관측하는 App Server 연결과 모델 요청을 중계하는 프록시는 역할이 다르며 함께 사용할 수도 있다.

공통 환경을 사용자의 현재 Codex 홈에서 직접 읽을지, 앱이 관리하는 공통 홈으로 가져올지 역시 미결정이다. 어느 쪽이든 계정별로 환경을 나누지 않는다는 원칙은 유지한다. 여러 프로세스가 같은 홈을 쓰는 경우의 캐시·DB·설정 쓰기와 전역 설정 변경 전파는 별도 검증 대상이다.

## 7. Evidence → Finding → Path

아래 경로는 모두 분석 기준 체크아웃을 가리킨다. 행 번호는 현재 파일 기준이며 링크와 함께 읽는다.

| 근거 ID | 소스 또는 관찰 | 확인한 사실 | 설계 반영 |
|---|---|---|---|
| E01 | [config loader](refs/codex/codex-rs/config/src/loader/mod.rs), 109–121행 | 사용자 홈과 프로젝트를 포함한 설정 계층 | 계정 선택과 환경 선택 분리 |
| E02 | [skill roots](refs/codex/codex-rs/ext/skills/src/host_roots.rs), 73행 이후 | 홈·프로젝트·시스템 스킬 경로 | 설정 파일 하나만 복사하는 방식 배제 |
| E03 | [user instructions](refs/codex/codex-rs/codex-home/src/instructions/mod.rs), 24행 이후 | 홈 기준 전역 지침 | 계정 변경 시 전역 지침 유지 |
| E04 | [config fields](refs/codex/codex-rs/config/src/config_toml.rs), 176·205·277·401행 | 권한·MCP·모델 URL 설정 | 구성과 라우팅 항목의 책임 구분 |
| E05 | [auth storage](refs/codex/codex-rs/login/src/auth/storage.rs), 154행 / [MCP OAuth](refs/codex/codex-rs/rmcp-client/src/oauth.rs), 파일 상단 | Codex와 MCP 인증 저장 경로 | 모델 계정과 도구 로그인 분리 |
| E06 | [account processor](refs/codex/codex-rs/app-server/src/request_processors/account_processor.rs), 823행 이후 / [external bridge](refs/codex/codex-rs/app-server/src/external_auth.rs) | 외부 인증 공급과 갱신 요청 | 설정과 인증을 분리할 기술적 후보 |
| E07 | [auth manager](refs/codex/codex-rs/login/src/auth/manager.rs), 2968행 이후 / [thread manager](refs/codex/codex-rs/core/src/thread_manager.rs), 666·1034행 | ephemeral 인증 반영과 공통 관리자 | 스레드별 독립 인증으로 오해하지 않음 |
| E08 | [installed schema](config-auth-verification/schema/v2/LoginAccountParams.json), chatgptAuthTokens 분기 | 바이너리에 존재하지만 내부용·불안정 명시 | 공개 API 안정성 보장 배제 |
| E09 | [account tests](refs/codex/codex-rs/app-server/tests/suite/v2/account.rs), 602·717·827행 / [Apps tests](refs/codex/codex-rs/app-server/tests/suite/v2/app_list.rs), 155행 | 갱신 실패·워크스페이스 제약·Apps 인증 관련 테스트가 존재 | 계정 교체 가능성과 서비스 가용성 별도 검증 |

## 8. 다음 검증과 합격 기준

먼저 합성 인증과 임시 환경으로 검증하며 실제 사용자 설정을 바꾸지 않는다. 아래는 후속 구현 검증 계획이며 이번에 수행한 결과가 아니다.

1. 같은 프로젝트·사용자 환경에서 계정 A/B를 교체해 스킬 목록·MCP 구성·전역 지침·권한 설정이 동일한지 비교한다. 설정 원문에 비밀값이 있을 수 있으므로 검증 기록에는 비밀값을 남기지 않는다.
2. 두 실제 세션을 동시에 실행해 한 세션의 계정 변경이 다른 세션의 인증에 영향을 주지 않는지 확인한다.
3. 같은 세션을 여러 작업 탭에 배치해도 프로세스·인증 갱신·요청이 중복 생성되지 않는지 확인한다.
4. 프록시 또는 외부 인증에서 401·한도 도달·연결 단절을 구분하고, 중복 도구 실행 없이 복구할 수 있는 경계를 확인한다.
5. 로컬 MCP 로그인 유지와 계정 종속 Apps의 차이를 별도로 검증한다. 모델 인증 교체 성공만으로 도구 환경 보존을 통과 처리하지 않는다.
6. 수십 개 세션의 공통 환경 동시 사용, 설정 변경 전파, CPU·메모리·종료·복원을 검증한다.

현재 통과한 것은 클론 확보·버전 확인·설치 바이너리의 프로토콜 스키마 생성·근거 파일 대조다. 실계정 이전, 계정 간 복구, 성능 검증은 미수행이다.

## 9. 후속 확인: 폴더 선택과 대화 재개, Orca 기록

2026-09-13 사용자 질문에 따라 설치 CLI의 `resume --help`와 현재 클론의 시작 분기를 확인했다. 같은 프로젝트 폴더에 들어가 `codex`를 실행하는 것만으로 기존 대화를 자동 선택하지 않는다. 기본 분기는 `StartFresh`다. `codex resume`은 선택기를 열고, `codex resume --last`는 기본적으로 현재 작업 경로로 범위를 좁혀 가장 최근 기록을 선택한다. `--all`은 경로 필터를 해제하며, `codex resume <SESSION_ID>`는 특정 기록을 선택한다. 이는 현재 기록 저장소 범위에서의 선택이며 `--all`이 다른 Codex 홈을 모두 합친다는 뜻이 아니다.

근거: [CLI 인자](refs/codex/codex-rs/cli/src/main.rs), 203·350행 이후 / [TUI 시작 분기](refs/codex/codex-rs/tui/src/lib.rs), 910·1488·1555행. 설치 바이너리 도움말도 선택기·`--last`·`--all` 동작을 명시한다. 현재 도구 셸에서 확인한 `codex` 래퍼 함수에는 `resume`·`--last` 문자열이 없었으며, 이것이 사용자가 여는 모든 셸의 동작까지 검증한 것은 아니다.

Orca 공식 저장소 `https://github.com/stablyai/orca.git`를 [refs/orca](refs/orca)에 얕은 클론으로 확보했다. 기준 커밋은 `56fcb544e0574ee38c53b9e09bee693a3232fb8d`다. 설치 Orca와 동일 버전이라는 검증은 하지 않았다.

Orca 소스는 Codex 기록을 기본 홈, `codex-runtime-home/home`, `codex-accounts/<id>/home` 등에서 탐색하며, 재개 명령에 세션 ID·작업 폴더·필요한 Codex 홈을 반영한다. 따라서 Orca에서 실행한 Codex 대화가 전부 독자 포맷이라는 설명은 부정확하다. 별도 Codex 홈에 있는 원래 Codex 기록과 Orca의 UI 메타데이터를 구분해야 한다. 현재 upstream에는 시스템 기본 계정을 실제 사용자 홈으로 보내는 경로도 있으므로 Orca 기록이 모두 관리 홈에 있다고 가정하지 않는다.

근거: [홈 선택](refs/orca/src/main/codex-accounts/runtime-home-service-paths.ts), 22행 이후 / [루트 중복 제거](refs/orca/src/main/ai-vault/codex-session-root-dedup.ts), 53행 이후 / [재개 명령 생성](refs/orca/src/shared/ai-vault-resume-command.ts), 15행 이후. 기존 계정 importer는 인증 가져오기이며 세션 이전이 아니다.

설계 반영 제안:

- 같은 Codex 기록 저장소를 사용하는 기존 세션은 별도 복사 없이 발견·선택·재개하는 경로를 우선한다.
- Orca 관리 홈에만 있는 기록을 Orca와 독립적으로 유지하려면 세션 가져오기가 필요하다. 원본 홈을 참조하는 재개는 가능하더라도 독립 이전 목표를 충족하지 않는다.
- 가져오기는 대화 ID·기록·관련 인덱스 및 버전별 부가 저장소의 정합성을 검증해야 한다. JSONL 하나를 복사하면 언제나 완전 복원이 된다고 가정하지 않는다. 실제 기록이나 DB는 이번에 읽거나 옮기지 않았다.
- 한 프로젝트에 여러 대화가 있을 수 있으므로 앱이 폴더 경로만을 세션 식별자로 사용해서는 안 된다. 기존 패널 재열기는 저장한 세션 ID를 사용하고, 새 세션 생성과 기존 대화 재개는 구분하는 것이 적절하다.

위 기능은 기술 확인과 설계 제안이며 세션 가져오기의 상세 범위를 모두 합의한 것으로 처리하지 않는다.
