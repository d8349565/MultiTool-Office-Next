import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/geist';
import App from './App';
import { initializeAssistantRuntime } from './assistantRuntime';
import './style.css';
void initializeAssistantRuntime().catch(()=>{});
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
