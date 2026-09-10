import {timingSafeEqual} from 'node:crypto';
import {eveChannel} from 'eve/channels/eve';
import {type AuthFn,localDev,vercelOidc,withAuthChallenges} from 'eve/channels/auth';

function windTunnelToken():AuthFn<Request>{
  return withAuthChallenges(request=>{
    const expected=process.env.WIND_TUNNEL_TOKEN??'';
    const authorization=request.headers.get('authorization')??'';
    const supplied=authorization.startsWith('Bearer ')?authorization.slice(7):'';
    const expectedBytes=Buffer.from(expected);const suppliedBytes=Buffer.from(supplied);
    if(!expected||expectedBytes.length!==suppliedBytes.length||!timingSafeEqual(expectedBytes,suppliedBytes))return null;
    return {authenticator:'wind-tunnel-token',principalId:'github-actions',principalType:'service',attributes:{}};
  },[{scheme:'Bearer'}]);
}

export default eveChannel({
  auth:[windTunnelToken(),vercelOidc(),localDev()],
  turnPolicy:'queue',
});
