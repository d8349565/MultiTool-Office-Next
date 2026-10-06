export type AssistantImage={id:string;name:string;mimeType:string;size:number};
export type ImagePayload=AssistantImage&{dataUrl:string};
export const imageTypes=['image/png','image/jpeg','image/webp','image/gif'];
export const maxImages=4;
export const maxImageBytes=5*1024*1024;

export function validateImage(file:Pick<File,'type'|'size'>){
  if(!imageTypes.includes(file.type))throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片。');
  if(!file.size||file.size>maxImageBytes)throw new Error('单张图片不能为空，且不能超过 5 MB。');
}
// 图片单独保存在本机，不占用文本会话的本地存储配额。
function imageDatabase():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('office-assistant-images',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('images');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(new Error('图片存储不可用，请检查本地存储空间。'));
  });
}
async function imageRequest<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await imageDatabase();
  try{return await new Promise<T>((resolve,reject)=>{
    const transaction=db.transaction('images',mode);
    const request=run(transaction.objectStore('images'));
    transaction.oncomplete=()=>resolve(request.result);
    transaction.onabort=()=>reject(new Error('图片保存或读取失败，请检查本地存储空间。'));
    transaction.onerror=()=>reject(new Error('图片保存或读取失败，请检查本地存储空间。'));
  });}finally{db.close();}
}
export async function saveImage(file:File):Promise<AssistantImage>{
  validateImage(file);
  // 本地解码检查，避免把伪装成图片的文件作为附件。
  try{const bitmap=await createImageBitmap(file);bitmap.close();}catch{throw new Error('图片无法打开，请换一张有效图片。');}
  const image={id:crypto.randomUUID(),name:file.name||'粘贴图片',mimeType:file.type,size:file.size};
  await imageRequest('readwrite',store=>store.put(file,image.id));
  return image;
}
export async function imageBlob(image:AssistantImage):Promise<Blob>{
  const blob=await imageRequest<Blob|undefined>('readonly',store=>store.get(image.id));
  if(!blob)throw new Error(`图片“${image.name}”已丢失，请移除后重新添加。`);
  return blob;
}
export async function deleteImages(images:AssistantImage[]){
  if(!images.length)return;
  const db=await imageDatabase();
  try{await new Promise<void>((resolve,reject)=>{
    const transaction=db.transaction('images','readwrite'),store=transaction.objectStore('images');
    for(const image of images)store.delete(image.id);
    transaction.oncomplete=()=>resolve();
    transaction.onabort=()=>reject(new Error('本地图片清理失败，请重试。'));
    transaction.onerror=()=>reject(new Error('本地图片清理失败，请重试。'));
  });}finally{db.close();}
}
export async function imagePayload(image:AssistantImage):Promise<ImagePayload>{
  const blob=await imageBlob(image);
  const dataUrl=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败，请重新添加。'));reader.readAsDataURL(blob);
  });
  return {...image,dataUrl};
}
export function imageReferences(value:unknown):AssistantImage[]{
  return Array.isArray(value)?value.filter((v):v is AssistantImage=>!!v&&typeof v.id==='string'&&typeof v.name==='string'&&imageTypes.includes(v.mimeType)&&Number.isInteger(v.size)&&v.size>0&&v.size<=maxImageBytes).slice(0,maxImages).map(({id,name,mimeType,size})=>({id,name,mimeType,size})):[];
}
// 当前图片优先；历史只携带最近的图片，整次请求最多四张。
export async function imageContext(history:{role:string;content:string;images?:AssistantImage[]}[],images:AssistantImage[]){
  if(images.length>maxImages)throw new Error('每次最多添加 4 张图片。');
  let remaining=maxImages-images.length;
  const seen=new Set(images.map(image=>image.id));
  const selected=history.map(item=>({...item,images:undefined as AssistantImage[]|undefined}));
  for(let i=history.length-1;i>=0;i--){
    if(!remaining||history[i].role!=='user')continue;
    const refs=(history[i].images||[]).filter(image=>!seen.has(image.id)).slice(-remaining);
    if(refs.length){selected[i].images=refs;remaining-=refs.length;refs.forEach(image=>seen.add(image.id));}
  }
  return {images:await Promise.all(images.map(imagePayload)),history:await Promise.all(selected.map(async item=>{
    if(!item.images?.length)return item;
    const payloads=await Promise.all(item.images.map(image=>imagePayload(image).catch(()=>null)));
    const available=payloads.filter((image):image is ImagePayload=>image!==null);
    return {...item,content:item.content+(available.length<payloads.length?'\n（部分历史图片已丢失，本轮未携带；请勿猜测其内容。）':''),images:available};
  }))};
}
