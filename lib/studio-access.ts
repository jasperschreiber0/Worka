export function loginDestination(input:string|null|undefined){
 if(!input||!input.startsWith('/')||input.startsWith('//')||/[\\\u0000-\u0020]/.test(input))return '/studio'
 try{const url=new URL(input,'https://worka.invalid');return url.origin==='https://worka.invalid'?url.pathname+url.search+url.hash:'/studio'}catch{return '/studio'}
}
export function recoveryIdentity(owner:string){
 if(owner!=='local-builder'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner))throw new Error('Sign in before opening browser recovery.')
 return owner
}
