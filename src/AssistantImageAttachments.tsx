import { useEffect, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { IconButton, Modal } from './components';
import { imageBlob, type AssistantImage } from './assistantImages';

function ImagePreview({image,onRemove}:{image:AssistantImage;onRemove?:()=>void}){
  const [src,setSrc]=useState(''),[error,setError]=useState('');
  const [preview,setPreview]=useState(false);
  useEffect(()=>{
    let alive=true,url='';setSrc('');setError('');
    void imageBlob(image).then(blob=>{if(alive){url=URL.createObjectURL(blob);setSrc(url);}}).catch(e=>{if(alive)setError(String(e));});
    return()=>{alive=false;if(url)URL.revokeObjectURL(url);};
  },[image.id]);
  return <figure className="assistant-image" title={error||image.name}>
    {src?<button type="button" onClick={()=>setPreview(true)} aria-label={`查看图片：${image.name}`}><img src={src} alt={image.name}/></button>:<span>{error?'图片已丢失':'正在加载'}</span>}
    <figcaption>{image.name}</figcaption>
    {onRemove&&<IconButton label={`移除图片：${image.name}`} onClick={onRemove}><X aria-hidden="true"/></IconButton>}
    {preview&&src&&<Modal title={image.name} wide onClose={()=>setPreview(false)}><img className="assistant-image-full" src={src} alt={image.name}/></Modal>}
  </figure>;
}
export function AssistantImages({images,onRemove}:{images:AssistantImage[];onRemove?:(image:AssistantImage)=>void}){
  return images.length?<div className="assistant-images" aria-label={onRemove?'待发送图片':'消息图片'}>{images.map(image=><ImagePreview key={image.id} image={image} onRemove={onRemove?()=>onRemove(image):undefined}/>)}</div>:null;
}
