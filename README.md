# 손글씨 방명록

행사장에서 참가자가 태블릿이나 휴대폰에 손으로 방명록을 쓰고 **남기기**를 누르면, 대형 화면(TV·프로젝터)에 그 방명록이 전체화면으로 떠오르는 웹 앱입니다. 로그인은 필요 없습니다.

## 화면 구성

| 주소 | 용도 |
| --- | --- |
| `/` | 시작 화면: 이 기기를 작성용 또는 전시용으로 고릅니다 |
| `/#write` | 작성용: **손글씨로 쓰기**(펜 색 6가지, 굵기 3단계, 되돌리기) 또는 **글자로 입력하기**(입력한 글자를 손글씨체 카드 이미지로 만들어 올림) 중 고르고, 남기기 |
| `/#display` | 전시용: 새 방명록을 전체화면으로 띄우고, 평소에는 방명록 벽을 보여줍니다. 화면 오른쪽 가운데에 ‘방명록 남기기’ QR과 ‘시뮬레이션센터 소개’ QR이 세로로 항상 떠 있습니다(소개 주소는 **관리자** 설정에서 입력) |
| `/#draw` | 추첨: 지금까지 모인 방명록 전체에서 1개를 무작위로 뽑아 크게 보여줍니다. 이미 뽑힌 방명록은 빼고 뽑을 수 있고, 당첨 기록은 그 기기에 남습니다 |

## Railway 배포

1. 이 저장소로 서비스를 만들면 `Dockerfile`로 빌드되고 `node server.js`로 실행됩니다.
2. **데이터베이스 추가:** 프로젝트 화면에서 **+ Create → Database → PostgreSQL**을 누릅니다.
3. 방명록 서비스의 **Variables**에 다음을 추가합니다.
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (값 입력칸에서 자동완성으로 고를 수 있습니다)
   - `ADMIN_PASSWORD`: 전시 화면의 **관리자** 버튼에서 쓸 비밀번호. 방명록 삭제와 행사 문구 변경에 필요하며, 없으면 두 기능이 꺼집니다.
4. **Settings → Networking**에서 Generate Domain으로 주소를 만듭니다.
5. `https://<주소>/api/health`에 `"storage":"postgres"`가 보이면 데이터베이스에 저장되고 있는 것입니다.

`PURGE_ENTRIES`에 새 값(예: 날짜)을 넣고 배포하면 시작할 때 방명록을 한 번만 모두 지웁니다. 같은 값으로 다시 시작해도 다시 지우지 않습니다.

`DATABASE_URL`이 없으면 `DATA_DIR`(기본 `./data`) 폴더에 파일로 저장합니다. 이때는 Railway 볼륨을 붙이지 않으면 재배포할 때 방명록이 사라집니다.

## 동작 방식

- `server.js`가 `index.html`을 내려주고, 방명록 이미지와 행사 설정을 PostgreSQL(`guestbook_entries`, `guestbook_config` 테이블, 처음 실행할 때 자동 생성)에 저장합니다.
- 새 방명록, 삭제, 설정 변경은 Server-Sent Events(`/api/events`)로 열려 있는 모든 화면에 바로 전달됩니다.
- 남용 방지를 위해 한 IP당 1분에 20장까지만 올릴 수 있고, 전체 방명록은 최대 2,000장입니다.
- 같은 `index.html`을 claude.ai 아티팩트로 열면 서버 대신 아티팩트의 공유 저장소를 사용합니다(이때는 로그인 필요). 서버 없이 파일만 열면 같은 브라우저의 탭끼리만 연결됩니다.

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 서버 확인 |
| GET | `/api/entries` | 최근 방명록 300개 (최신순). `?all=1`이면 전체 (추첨용) |
| POST | `/api/entries` | `{ "img": "data:image/...;base64,..." }` 방명록 올리기 |
| DELETE | `/api/entries/:id` | 삭제 (헤더 `X-Admin-Key`) |
| DELETE | `/api/entries` | 방명록 전체 삭제 (헤더 `X-Admin-Key`). 관리자 창의 **방명록 전체 삭제** 버튼 |
| GET / PUT | `/api/config` | 행사 이름·안내 문구·표시 시간·QR 표시·소개 페이지 주소(`introUrl`)와 문구(`introLabel`) (PUT은 `X-Admin-Key`) |
| GET | `/api/events` | 실시간 이벤트 스트림 |

## 로컬 실행

```bash
npm install
```

```bash
ADMIN_PASSWORD=비밀번호 node server.js
```

http://localhost:8080 을 열면 됩니다.
