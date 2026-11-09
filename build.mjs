// app/index.src.html の /*__ESN__*/ に app/esn.js をそのまま埋め込み、app/index.html（外の読み込み無しの 1 枚）を作る
import fs from 'node:fs';
const dir = new URL('./app/', import.meta.url);
const esn = fs.readFileSync(new URL('esn.js', dir), 'utf8');
const src = fs.readFileSync(new URL('index.src.html', dir), 'utf8');
if (esn.includes('</script')) throw new Error('esn.js に </script が含まれています');
fs.writeFileSync(new URL('index.html', dir), src.replace('/*__ESN__*/', () => esn));
console.log('app/index.html を作りました', fs.statSync(new URL('index.html', dir)).size, 'バイト');
