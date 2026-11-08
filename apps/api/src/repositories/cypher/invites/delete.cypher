MATCH (i:Invite {token: $token})
DETACH DELETE i
