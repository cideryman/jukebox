# 주크박스 코드 검토 보고서

## 관점 1: 사용자 접근성 및 UX (인지/운동 능력)

### ✅ 잘된 점

**텍스트 0%, 조작 0% 계약 준수**  
`renderJukebox()`가 생성하는 사용자 화면은 버튼과 이미지만 렌더링하며, 텍스트나 추가 조작 요소가 일절 없다. `aria-label`만 스크린리더용으로 붙어 있다.

**빈 슬롯 처리**  
`is-empty` 클래스로 `visibility: hidden; pointer-events: none`을 적용해 빈 슬롯이 완전히 보이지 않고 눌리지도 않는다. 빈 자리가 회색 박스로 남아있는 흔한 실수를 피했다.

**저장 중 상태 차단**  
`savingSlots` Set과 `maintenanceBusy` 플래그로 저장 중인 슬롯 버튼을 비활성화(`button.disabled`)해서 이중 저장 경쟁 상태를 방지한다.

**반복 터치 안정화 (ActivationGuard)**  
`attempt()` → `blockedUntil` 연장 구조가 깔끔하다. 최초 입력은 즉시 실행하고, 이후 700ms 동안은 어느 슬롯이든 무시한다.

**안정화 시각 피드백**  
`is-stabilizing` 클래스로 청록색 안쪽 테두리를 그려 "이미 선택되었다"는 신호를 글자 없이 전달한다.

### ⚠️ 개선 여지

**`ActivationGuard`의 전역(Global) 특성**  
현재 안정화 구간은 슬롯 구분 없이 전체를 차단한다. A 카드를 눌렀을 때 700ms 동안 B, C 카드도 차단된다. HANDOFF.md 설계 의도와 일치하긴 하나, 설정 창 안에서도 이 가드가 간접적으로 작동할 수 있다는 점이 잠재적 혼동 요소다.

**`window.confirm()` 사용**  
`clearSlot()`, `clearStatsForTrack()`, `clearAllStats()`, `importBackup()` 네 곳에서 `window.confirm()`을 사용한다. iOS Safari PWA 모드에서 `confirm()`이 아무런 대화상자 없이 `false`를 반환하는 경우가 있다(iOS 15 이전 일부 버전). 보호자가 실수로 슬롯을 날리는 상황을 막는 핵심 UX인데, 네이티브 `<dialog>` 기반 확인 다이얼로그로 교체하는 것이 훨씬 안전하다.

**설정 닫기 실패 피드백이 약하다**  
저장 중에 확인 버튼을 누르면 `showToast("파일 저장이 끝난 뒤…")`로 안내하는데, 보호자가 토스트를 미처 읽지 못하거나 무시할 수 있다. 버튼 자체를 `disabled`로 차단하는 것이 더 명확하다. 현재 텍스트는 "저장 중…"으로 바뀌지만 `disabled`가 걸리지 않아 클릭 이벤트가 계속 발생한다.

---

## 관점 2: 데이터 보존과 원자성

### ✅ 잘된 점

**OPFS → IDB → 구 파일 삭제 순서**  
`saveSlotFile()`의 저장 순서가 완벽하다. 새 파일을 OPFS에 먼저 쓰고, IDB 메타 커밋이 성공한 경우에만 이전 파일을 삭제한다. IDB 실패 시 새로 쓴 OPFS 파일을 즉시 롤백한다.

**`_enqueueSlotOperation()` 뮤텍스**  
같은 슬롯에 대한 병렬 저장·삭제가 직렬화된다. 복원과 저장이 동시에 시작해도 안전하다.

**백업 복원의 원자성 (restoreBackupSnapshot)**  
새 파일을 모두 OPFS에 스테이징한 뒤, 한 번의 IDB 트랜잭션으로 slots/settings/stats를 동시에 커밋한다. 트랜잭션 실패 시 스테이징된 파일만 정리하고 기존 IDB 데이터는 손대지 않는다.

**`oncomplete` 이후 resolve**  
`_putMetaToDb`, `_deleteMetaFromDb`, `_updatePlaybackStats` 등 모든 IDB 쓰기가 `tx.oncomplete`에서만 resolve하고, `onerror`와 `onabort`를 함께 reject로 처리한다.

### ⚠️ 개선 여지

**`removeSlot()`의 삭제 순서 역전**  
`removeSlot()`은 `_deleteMetaFromDb()` → `_deleteFileFromOpfs()` 순서다. IDB 삭제가 성공한 직후 앱이 비정상 종료되면 OPFS 파일이 고아(orphan)로 남는다. 다음 실행의 `_cleanOrphanedFiles()`가 정리하긴 하지만, 설계 일관성 면에서 IDB 삭제 성공 후에만 OPFS를 삭제하는 순서가 더 낫다.

**`updateAppCache()`의 비회귀 위험**  
캐시 갱신 로직이 "모든 캐시 키 삭제 → reload"다. 갱신 실패 시에도 reload를 시도한다. 네트워크가 없는 상태에서 버튼을 누르면 캐시가 지워진 채로 오프라인 재접속이 되어 앱 자체가 빈 화면이 될 수 있다. 오프라인 상태를 먼저 감지하거나, 새 캐시 fetch가 성공한 경우에만 기존 캐시를 삭제하는 순서로 변경해야 한다.

**백업 stats 필드 하위 호환성**  
`validateManifest()`가 `Array.isArray(manifest.stats)` 체크를 먼저 하므로 실제 에러는 잡힌다. 단, `stats` 필드 자체가 없는 오래된 백업의 경우를 더 명시적으로 처리(`manifest.stats ?? []`)하면 하위 호환 의도가 코드에서 바로 보인다.

---

## 관점 3: 보호자/사용자 분리

### ✅ 잘된 점

**톱니바퀴 2초 유지 구조**  
`startSettingsHold` → `setTimeout(HOLD_DURATION_MS)` → `cancelSettingsHold` 구조가 `pointerdown`, `pointerup`, `pointercancel`을 모두 처리한다. `event.button !== 0` 체크로 우클릭을 차단하고, `contextmenu` 이벤트도 방지한다.

**설정 창 백드롭 클릭 닫기**  
`settingsDialog.addEventListener("click", …)`로 다이얼로그 외부 클릭도 닫기를 처리하되, 저장 중이면 닫히지 않는다.

**최대 음량이 보호자 영역에만 존재**  
사용자 화면에는 음량 관련 UI가 전혀 없다.

### ⚠️ 개선 여지

**iOS PWA에서 `window.confirm()` 차단 문제**  
특히 슬롯 삭제 확인이 `window.confirm()`을 쓴다는 점이 보호자 UX에서 치명적일 수 있다. iOS PWA에서 confirm이 무시되면 보호자가 삭제를 의도했는지 여부를 알 수 없다.

**화면 전환 저장 실패 시 UI 플리커**  
`persistCurrentScreen()` 실패 시 `applyCurrentScreen(persistedCurrentScreen)`으로 롤백하는데, 이미 `renderAll()`이 두 번 호출되는 과정에서 UI가 잠깐 다른 화면을 보여줬다가 돌아오는 깜빡임이 생길 수 있다. 저장 성공을 확인한 후에만 UI를 전환하는 순서가 더 안전하다.

---

## 관점 4: 저사양 하드웨어 성능

### ✅ 잘된 점

**단일 `<audio>` 엘리먼트**  
27개 슬롯이 존재하지만 `<audio>` 엘리먼트는 하나다. 재생 시 `audio.src`를 교체하므로 메모리 경합이 없다.

**Blob URL 생명주기 관리**  
`registerFile()`에서 새 URL을 만들기 전에 `URL.revokeObjectURL()`로 이전 URL을 해제한다. `pagehide`와 `beforeunload`에서도 전체 해제를 호출한다.

**DocumentFragment 사용**  
`renderJukebox()`가 오프스크린에서 DOM을 구성한 뒤 `replaceChildren()`으로 한 번에 교체해 Reflow를 최소화한다.

### ⚠️ 개선 여지

**백업 생성 시 파일 전체를 arrayBuffer()로 로드**  
`analyzeBlob()`이 SHA-256과 CRC32를 위해 파일 전체를 `new Uint8Array(await blob.arrayBuffer())`로 읽는다. 27개 슬롯 모두를 백업할 때 30MB짜리 MP3가 여러 개이면 저사양 태블릿(2~3GB RAM)에서 OOM이 발생할 수 있다. 현재는 `for` 루프로 직렬 처리하고 있어서 최악의 경우는 방지하고 있으나, CRC32 계산이 순수 JS 바이트 순회라 큰 파일에서 메인 스레드를 수백ms 점유한다. 백업 시작 전 사용자에게 진행 중 표시를 명확히 하거나, 향후 Web Worker로 오프로드를 고려해야 한다.

**`renderSettings()`가 매우 비싸다**  
설정 저장 중 상태 변화마다 9개 슬롯 에디터를 완전히 재생성한다. 설정 창이 열려 있는 동안 슬롯 등록, 음량 변경, 화면 전환이 복합으로 일어나면 불필요한 DOM 재생성이 반복된다. 슬롯 에디터와 전역 설정(음량, Wake Lock 등)의 렌더 경로를 분리하는 것이 좋다.

---

## 추가 조언 (4개 관점 외)

### 1. `window.confirm()` 전면 교체 — **가장 시급**

위에서 반복됐지만 우선순위가 가장 높다. iOS Safari PWA에서 `confirm()`이 항상 `false`를 반환한 사례가 있다. 커스텀 `<dialog>` 기반 컨펌 컴포넌트가 이 앱에서 유일하게 빠진 인프라다.

### 2. ZIP 파서 단위 테스트 부재

`test.html`은 백업·복원 왕복 시나리오 테스트는 있지만, ZIP 바이너리 파싱 자체(`readZipEntries`)의 경계값 테스트가 없다. 22바이트 최소 파일, 외부 zip 도구로 만든 파일을 가져오는 크로스-호환 테스트가 없으면 파서가 수정될 때 회귀를 잡기 어렵다.

### 3. `formatVersion: 1` 고정 비교

현재 `validateManifest()`가 `formatVersion !== 1`이면 무조건 오류를 던진다. 앞으로 형식이 바뀌면 버전 1 파일이 영구히 읽히지 않게 된다. `formatVersion >= 1`로 비교하거나 버전별 파싱 경로를 분기하는 구조를 미리 잡아두는 것이 좋다.

### 4. `sw.js`의 `skipWaiting()` 위치

`self.skipWaiting()`이 `event.waitUntil()` 바깥에서 호출된다. 느린 기기에서 캐시 `addAll()`이 완료되기 전에 새 워커가 활성화될 수 있다. `event.waitUntil(caches.open(…).then(…).then(() => self.skipWaiting()))`처럼 캐시 완료 후에 `skipWaiting()`을 호출하는 것이 안전하다.

### 5. `clearSlot()`의 메모리-스토리지 불일치 가능성

`removeSlot()` 내부에서 에러가 전파될 경우, `clearSlot()`의 catch에서 토스트를 보여주는 시점에 메모리 슬롯은 이미 초기화된 상태다. IDB에서는 삭제됐지만 OPFS 파일이 남아 고아 파일이 생기고, UI는 슬롯이 비워진 것처럼 보일 수 있다. `storage.removeSlot()` 성공을 확인한 뒤에 메모리 슬롯을 초기화하도록 순서를 조정해야 한다.

### 6. 실기기 성능 데이터 없음

30초 청취 체크포인트(`STATS_CHECKPOINT_MS`)가 `window.setTimeout`으로 구현되어 있다. 구형 Android 태블릿에서 메모리·배터리·청취 시간 정확도를 검증한 데이터가 없다. 최소한 보호자 모드에서 현재 누적 청취 시간을 확인할 수 있는 디버그 출력이 있으면 문제 추적이 쉬워진다.
