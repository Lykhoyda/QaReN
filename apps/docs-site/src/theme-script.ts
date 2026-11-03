import { BASE_PATH, pagePath } from './site.ts';

const home = `${BASE_PATH}${pagePath('')}`;

export const themeScript = `document.documentElement.dataset.theme=location.pathname===${JSON.stringify(home)}?'dark':'light';try{var t=localStorage.getItem('qaren-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;
