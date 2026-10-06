import { Button } from '@fluentui/react-components';
import { Heart, QrCode, SquaresFour } from '@phosphor-icons/react';
import { productName, version } from '../src-tauri/tauri.conf.json';
import { Modal } from './components';

const images = import.meta.glob<string>('./assets/sponsor/wechat.{png,jpg,jpeg,webp}', { eager: true, query: '?url', import: 'default' });
const wechatImage = Object.values(images)[0];

export function AboutView({ onClose }: { onClose: () => void }) {
  return <Modal title="关于" onClose={onClose}>
    <div className="about-brand"><span className="brand-mark"><SquaresFour size={26} weight="fill"/></span><div><h3>{productName}</h3><p>让日常办公更顺手。</p></div></div>
    <dl className="about-version"><dt>当前版本</dt><dd>{version}</dd></dl>
    <section className="about-sponsor" aria-labelledby="about-sponsor-title">
      <h3 id="about-sponsor-title"><Heart size={18}/>赞赏项目</h3>
      <p>如果这个工作台帮到了你，欢迎支持项目的持续维护。赞赏完全自愿。</p>
      <div className="about-payment-options"><div className="about-payment"><h4>微信赞赏</h4>{wechatImage ? <><img src={wechatImage} alt="微信赞赏码" width={200} height={200}/><p>使用微信扫一扫</p></> : <div className="about-payment-pending"><QrCode size={44} weight="thin" aria-hidden="true"/><span>暂未提供赞赏码</span></div>}</div></div>
    </section>
    <footer className="dialog-actions"><Button appearance="primary" onClick={onClose}>关闭</Button></footer>
  </Modal>;
}
