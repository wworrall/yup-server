import * as yup from "yup";
import http, { IncomingMessage, ServerResponse } from "node:http";
import {
  ImATeapot,
  InternalServerError,
  NotFound,
  UnprocessableEntity,
} from "http-errors";

type Context<User = any, Body = any, Query = any, Params = any> = {
  user: User;
  body: Body;
  query: Query;
  params: Params;
};

type RequestHandlerFunction<T extends Context = Context> = (params: {
  ctx: T;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) => any;

type RequestHandler<T extends Context = Context> = {
  handler: RequestHandlerFunction<T>;
  bodySchema?: yup.AnySchema;
  paramsSchema?: yup.AnySchema;
  querySchema?: yup.AnySchema;
  responseSchema?: yup.AnySchema;
};

type HTTPMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Route<T extends Context = Context> = {
  pattern: RegExp;
  "*"?: RequestHandler<T>;
  GET?: RequestHandler<T>;
  PUT?: RequestHandler<T>;
  PATCH?: RequestHandler<T>;
  POST?: RequestHandler<T>;
  DELETE?: RequestHandler<T>;
};

type ExecuteRequestHandlerInput<T extends Context = Context> = {
  requestHandler: RequestHandler;
  req: IncomingMessage;
  res: ServerResponse;
  pattern: RegExp;
  ctx: T;
};

async function executeRequestHandler<T extends Context = Context>({
  requestHandler,
  req,
  res,
  pattern,
  ctx,
}: ExecuteRequestHandlerInput<T>) {
  const { handler, bodySchema, paramsSchema, querySchema, responseSchema } =
    requestHandler;

  if (bodySchema) {
    let body = "";

    req.on("data", function (chunk) {
      body += chunk;
    });

    await new Promise((resolve) => req.on("end", resolve));

    let validatedBody: any;
    try {
      validatedBody = await bodySchema.validate(JSON.parse(body));
    } catch (err: any) {
      throw new UnprocessableEntity(err.message);
    }

    ctx.body = validatedBody;
  }

  if (paramsSchema) {
    const regexResult = pattern.exec(req.url?.split("?")[0] || "");

    if (!regexResult) {
      throw new UnprocessableEntity("no url parameters found");
    }

    let validatedParams: any;
    try {
      validatedParams = await paramsSchema.validate(regexResult.groups);
    } catch (err: any) {
      throw new UnprocessableEntity(err.message);
    }

    ctx.params = validatedParams;
  }

  if (querySchema) {
    const queryString = req.url?.split("?")[1] || "";

    const query = Object.fromEntries(
      new URLSearchParams(queryString).entries()
    );

    let validatedQuery;
    try {
      validatedQuery = await querySchema.validate(query);
    } catch (err: any) {
      throw new UnprocessableEntity(err.message);
    }

    ctx.query = validatedQuery;
  }

  let handlerRes = await handler({ ctx, req, res });

  // the handler took care of the response
  if (res.headersSent) return;

  // the handler didn't return any data to send so we don't return anything
  // this handler was likely middleware
  if (handlerRes === undefined) return;

  if (responseSchema) {
    // data from response shouldn't need to be parsed/coerced
    handlerRes = await responseSchema.validate(handlerRes, { strict: true });
  }

  // promisify and await so this function doesn't return until after response
  // is sent
  await new Promise<void>((resolve) => {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(handlerRes), resolve);
  });
}

/**
 * Generate a request handler function suitable for use with http.createServer()
 */
function createServer(routes: Route[]) {
  return async function requestHandler(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    try {
      const url = req.url?.split("?")[0];
      const method = req.method?.toUpperCase() as HTTPMethod;
      if (!url || !method) throw new ImATeapot(); // this should never happen

      const ctx: Context = {
        body: undefined,
        user: undefined,
        query: undefined,
        params: undefined,
      };

      for (let route of routes) {
        if (!route.pattern.test(url)) continue;

        const allRequestMethodsHandler = route["*"];
        if (allRequestMethodsHandler) {
          await executeRequestHandler({
            requestHandler: allRequestMethodsHandler,
            req,
            res,
            pattern: route.pattern,
            ctx,
          });
        }

        if (res.headersSent) return;

        const specificRequestMethodHandler = route[method];
        if (!specificRequestMethodHandler) continue;

        await executeRequestHandler({
          requestHandler: specificRequestMethodHandler,
          req,
          res,
          pattern: route.pattern,
          ctx,
        });

        if (res.headersSent) return;
      }

      throw new NotFound(`${method} ${url}`);
    } catch (err: any) {
      if (process.env.NODE_ENV !== "production") console.log(err);
      if (res.headersSent) return;

      let message = err.message;
      const statusCode = err.statusCode || 500;

      if (statusCode >= 500 && process.env.NODE_ENV === "production") {
        message = "internal server error";
      }

      res
        .writeHead(statusCode, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message }));
    }
  };
}

type ConnectMiddleware = <Req = IncomingMessage, Res = ServerResponse>(
  req: Req,
  res: Res,
  next: (err?: unknown) => void
) => void;

type ConnectMiddlewareErrorHandler = (err: unknown) => any;

/**
 * Generate a request handler function that will execute connect-style middleware.
 *
 * @param connectMiddleware The middleware to execute
 * @param errorHandler The error handler to execute if the middleware returns an error
 *
 * @returns A request handler function
 *
 */
function useConnectMiddleware(
  connectMiddleware: ConnectMiddleware,
  errorHandler?: ConnectMiddlewareErrorHandler
): RequestHandlerFunction {
  return async function ({ req, res }) {
    let middlewareError = await new Promise<unknown | undefined>((resolve) => {
      connectMiddleware(req, res, (err) => {
        resolve(err);
      });
    });

    if (middlewareError) {
      if (!errorHandler) {
        throw new InternalServerError(`Middleware error: ${middlewareError}`);
      }
      await errorHandler(middlewareError);
    }
  };
}

export {
  ConnectMiddleware,
  ConnectMiddlewareErrorHandler,
  Context,
  HTTPMethod,
  RequestHandler,
  RequestHandlerFunction,
  Route,
  useConnectMiddleware,
  createServer,
};
