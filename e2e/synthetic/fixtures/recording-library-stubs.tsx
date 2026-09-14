import type { AnchorHTMLAttributes } from 'react';
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props}/>; }
export function useRouter() { return { push: (url: string) => { document.querySelector('#last-navigation')!.textContent = url; } }; }
export function createClient() { return { auth: { onAuthStateChange: () => ({data:{subscription:{unsubscribe(){}}}}) } }; }
