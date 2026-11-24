// __DIMENSIONS__ is replaced with the embeddings run's dimension (an integer, checked by the caller).
CREATE VECTOR INDEX FOR (n:Activity) ON (n.embedding) OPTIONS {dimension: __DIMENSIONS__, similarityFunction: 'cosine'}
