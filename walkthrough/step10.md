# 10단계: 보호자 설정 기반 다중 화면 세트 (화면 1, 2, 3) 관리 완료 보고서

## 1. 구현 개요
- **목적**: 플레이 화면의 9칸(3×3) 구조와 조작 단순성을 그대로 유지하면서, 보호자 설정에서 화면 세트(화면 1, 화면 2, 화면 3)를 전환하여 총 27개의 슬롯을 분할 관리할 수 있도록 지원합니다.
- **핵심 원칙**: 
  - 플레이 화면에는 추가 조작 UI를 일절 노출하지 않습니다.
  - 27개 슬롯은 시작 시점에 메모리에 모두 로드되어 화면 전환 시에도 재생 중인 음악이 끊기지 않습니다.
  - 슬롯 편집기와 화면 세트 선택 UI를 보호자 설정 창의 상단으로 재배치하여 사용성을 극대화했습니다.

## 2. 주요 변경 사항
1. **`storage.js`**
   - `TOTAL_SLOTS` 상수값을 `9`에서 `27`로 상향.
   - `normalizeScreenId(value)` 헬퍼 함수 추가 (기본값: 1, 허용값: 1, 2, 3).
   - 설정 DB(`app-settings`)에 `currentScreen` 필드 추가 및 `getSettings()`, `saveSettings()`, `restoreBackupSnapshot()`에서 처리.

2. **`backup.js`**
   - 슬롯 수 제한을 27개로 상향하고 `MAX_ENTRY_COUNT`를 128로 확장.
   - `createBackupArchive()` 및 `readBackupArchive()`에서 `currentScreen` 설정값 직렬화/역직렬화 지원.

3. **`app.js`**
   - `SLOT_COUNT = 27`로 확장.
   - `currentScreen`, `persistedCurrentScreen` 상태 관리 및 `applyCurrentScreen()`, `persistCurrentScreen()` 구현.
   - `renderJukebox()`: 현재 `currentScreen`에 해당하는 9개 슬롯만 잘라서(slice) 렌더링.
   - `renderSettings()`: 현재 `currentScreen`에 해당하는 9개 슬롯 편집기만 렌더링.
   - 화면 세트 라디오 버튼 변경 이벤트 바인딩.

4. **`index.html` & `styles.css`**
   - 보호자 설정 창 상단(헤더 바로 아래)에 `화면 세트 선택 (화면 1, 화면 2, 화면 3)` 라디오 버튼 그룹 UI 추가.
   - `.screen-panel`, `.screen-options`, `.screen-option` 스타일 정의.

5. **`sw.js` & `test.html`**
   - 캐시 버전을 `jukebox-shell-v18`로 갱신.
   - `test.html` 3번 테스트(27개 슬롯) 및 22번 테스트(다중 화면 설정/정규화/백업 왕복) 추가.

## 3. 검증 결과
- **통합 테스트**: `test.html` 러너의 **22/22개 테스트 전체 통과 (ALL PASS)**
- **UI 시나리오 검증**:
  - 보호자 설정 진입 시 화면 세트 선택 패널 및 슬롯 1~9 정상 표시.
  - "화면 2 (10~18번)" 선택 시 슬롯 편집기가 즉시 10번~18번 칸으로 갱신.
  - 설정을 닫고 메인 화면으로 돌아왔을 때 선택된 화면 2의 슬롯 상태 반영 확인.
