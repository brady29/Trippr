// __DIMENSIONS__ is replaced with the embeddings run's dimension (an integer, checked by the caller).
CREATE VECTOR INDEX activity_embedding IF NOT EXISTS FOR (n:Activity) ON n.embedding
OPTIONS {indexConfig: {`vector.dimensions`: __DIMENSIONS__, `vector.similarity_function`: 'cosine'}}
