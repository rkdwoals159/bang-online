import "./cards.css";

/** Visible source credits and license notes for the prepared card artwork. */
export function CardAssetAttribution() {
  return (
    <details className="card-attribution">
      <summary>카드 이미지 출처 및 이용 안내</summary>
      <ul>
        <li>
          플레이 카드 이미지: STOPNOW, 「[보드게임] 뱅 (BANG) 카드 설명 - NO.15-1」,
          2021-01-28. 합성 이미지에서 개별 카드면을 잘라 편집했습니다. 글에 표시된
          라이선스는{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
          이며 <a href="https://stopnow.tistory.com/25" target="_blank" rel="noreferrer">원문</a>에서
          확인할 수 있습니다.
        </li>
        <li>
          역할 카드 이미지: 푸실(Pusil), 「[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15」,
          2021-01-25. 합성 이미지에서 개별 역할 카드를 잘라 편집했습니다. 글에 표시된
          라이선스는{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
          이며 <a href="https://stopnow.tistory.com/24" target="_blank" rel="noreferrer">원문</a>에서
          확인할 수 있습니다.
        </li>
        <li>
          인물 카드 이미지: 모노폴리 가이드(Monopoly), 「보드게임 뱅 - 캐릭터 평가」,
          2011-08-07. 글은 원 출처로 q3c273 Tistory의 닌자토끼 블로그를 표기합니다.
          (<a href="http://q3c273.tistory.com/258" target="_blank" rel="noreferrer">원 출처</a>)
          네이버 글에서 별도 CC 라이선스는 확인되지 않았습니다. 게임 카드 그림은
          사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따라 사용합니다.
          <a href="https://m.blog.naver.com/monopolygame/20134581005" target="_blank" rel="noreferrer">
            원문
          </a>
        </li>
      </ul>
      <p>
        게임 카드 아트워크의 별도 권리와 배포 조건은 블로그 이미지 라이선스와 구분되며,
        사용자가 받은 코리아보드게임즈 허가 이메일을 따릅니다.
      </p>
    </details>
  );
}
