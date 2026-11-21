# 손글씨 방명록

행사장에서 참가자가 태블릿이나 휴대폰에 손으로 방명록을 쓰고 **남기기**를 누르면, 대형 화면(TV·프로젝터)에 그 방명록이 전체화면으로 떠오르는 웹 앱입니다. 로그인은 필요 없습니다.

## 화면 구성

| 주소 | 용도 |
| --- | --- |
| `/` | 시작 화면: 이 기기를 작성용 또는 전시용으로 고릅니다 |
| `/#write` | 작성용: 펜 색 6가지, 굵기 3단계, 되돌리기, 모두 지우기, 남기기 |
| `/#display` | 전시용: 새 방명록을 전체화면으로 띄우고, 평소에는 방명록 벽과 휴대폰 참여 QR 코드를 보여줍니다 |

## Railway 배포

1. 이 저장소로 서비스를 만들면 `npm start`(`node server.js`)로 실행됩니다. 외부 패키지는 없습니다.
2. **Variables**에 다음을 추가합니다.
   - `ADMIN_PASSWORD`: 전시 화면의 **관리자** 버튼에서 쓸 비밀번호입니다. 방명록 삭제와 행사 문구 변경에 필요해요. 없으면 두 기능이 꺼집니다.
   - `DATA_DIR=/data`: 아래 볼륨을 쓸 때 지정합니다.
3. **볼륨을 꼭 붙이세요.** 서비스에서 Volume을 만들고 마운트 경로를 `/data`로 지정합니다. 볼륨이 없으면 재배포하거나 재시작할 때 방명록이 모두 사라집니다.
4. **Settings → Networking**에서 Generate Domain으로 주소를 만들고, 포트는 앱이 쓰는 `PORT`(Railway 기본 8080)에 맞춥니다.

## 동작 방식

- `server.js`가 `index.html`을 내려주고, 방명록 이미지를 `DATA_DIR/img/`에, 목록과 설정을 `DATA_DIR/meta.json`에 저장합니다.
- 새 방명록, 삭제, 설정 변경은 Server-Sent Events(`/api/events`)로 열려 있는 모든 화면에 바로 전달됩니다.
- 남용 방지를 위해 한 IP당 1분에 20장까지만 올릴 수 있고, 전체 방명록은 최대 2,000장입니다.
- 같은 `index.html`을 claude.ai 아티팩트로 열면 서버 대신 아티팩트의 공유 저장소를 사용합니다(이때는 로그인 필요). 서버 없이 파일만 열면 같은 브라우저의 탭끼리만 연결됩니다.

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 서버 확인 |
| GET | `/api/entries` | 최근 방명록 300개 (최신순) |
| POST | `/api/entries` | `{ "img": "data:image/...;base64,..." }` 방명록 올리기 |
| DELETE | `/api/entries/:id` | 삭제 (헤더 `X-Admin-Key`) |
| GET / PUT | `/api/config` | 행사 이름·안내 문구·표시 시간·QR 표시 (PUT은 `X-Admin-Key`) |
| GET | `/api/events` | 실시간 이벤트 스트림 |

## 로컬 실행

```bash
ADMIN_PASSWORD=비밀번호 node server.js
```

http://localhost:8080 을 열면 됩니다.
