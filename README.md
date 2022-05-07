# Yup Server

A lightweight server framework that uses Yup for data validation

## How to use:

```typescript
const app = createServer([...middleware, ...routes]);

http.createServer(app).listen(3001, () => {
  console.log("Server listening att http://localhost:3001");
});
```

## Contributing

If you have any suggestions please open up an issue.

## License

[MIT License](http://opensource.org/licenses/MIT)
