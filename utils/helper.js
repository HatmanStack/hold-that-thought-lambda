export const formatResponse = (statusCode, body) => {
    return {
        statusCode,
        body: JSON.stringify(body),
    };
};