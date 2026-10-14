import './styles/tokens.css';
import './styles/base.css';
import { render } from 'preact';
import { App } from './app.tsx';
import { startSession } from './lib/session.ts';

void startSession();
render(<App />, document.getElementById('app') as HTMLElement);
