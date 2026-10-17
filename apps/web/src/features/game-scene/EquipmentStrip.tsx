import type { CardFaceView } from "../../../../../packages/contracts/src/protocol.js";
import { PlayingCardZoomButton } from "../cards/CardFaces.js";
import { cardName } from "../actions/model.js";

const ranges: Readonly<Record<string,number>> = {volcanic:1,schofield:2,remington:3,carabine:4,winchester:5};
export function EquipmentStrip({cards,owner}:{cards:readonly CardFaceView[];owner:string}){
  if(!cards.length)return null;
  const ownerLabel=owner==="내"?"내":`${owner}의`;
  return <ul className="scene-equipment-strip" aria-label={`${ownerLabel} 장착 카드`}>
    {cards.map(card=>{
      const range=ranges[card.typeId],hazard=card.typeId==="jail"||card.typeId==="dynamite";
      return <li key={card.cardInstanceId} className={hazard?"is-hazard":range?"is-weapon":undefined}>
        <PlayingCardZoomButton card={card} triggerLabel={`${ownerLabel} ${cardName(card.typeId)}${range?`, 사거리 ${range}`:""} 상세 보기`}/>
        <span className="scene-equipment-strip__name">{cardName(card.typeId)}</span>
        {range?<span className="scene-equipment-strip__range" aria-label={`사거리 ${range}`}>{range}</span>:null}
      </li>;
    })}
  </ul>;
}
