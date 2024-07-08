const express = require('express');
const OpenAI = require('openai');
const { Sequelize, DataTypes } = require('sequelize');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sequelize = new Sequelize({ dialect: 'sqlite', storage: './database.sqlite' });

const User = sequelize.define('User', {
  userId: { type: DataTypes.STRING, primaryKey: true },
  fullName: DataTypes.STRING,
  email: DataTypes.STRING,
  lastInteraction: DataTypes.DATE
});

const Conversation = sequelize.define('Conversation', {
  userId: DataTypes.STRING,
  messages: DataTypes.TEXT
});

sequelize.sync();

async function getRooms() {
  try {
    const response = await axios.get('https://bot9assignement.deno.dev/rooms');
    return response.data;
  } catch (error) {
    console.error('Error fetching rooms:', error);
    return [];
  }
}

async function bookRoom(roomId, fullName, email, nights) {
  try {
    const response = await axios.post('https://bot9assignement.deno.dev/book', {
      roomId, fullName, email, nights
    });
    return response.data;
  } catch (error) {
    console.error('Error booking room:', error);
    return null;
  }
}

function simulatePayment(amount, method) {
  return { status: 'success', message: `Payment of $${amount} processed via ${method}` };
}

app.post('/chat', async (req, res) => {
  const { message, userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    let [user] = await User.findOrCreate({ 
      where: { userId },
      defaults: { lastInteraction: new Date() }
    });
    
    await user.update({ lastInteraction: new Date() });

    let [conversation] = await Conversation.findOrCreate({ 
      where: { userId },
      defaults: { messages: '[]' }
    });

    let messages = JSON.parse(conversation.messages);
    messages.push({ role: 'user', content: message });

    const systemMessage = `
      You are a polite and helpful hotel booking assistant chatbot. Always maintain a friendly and professional tone.
      Key points:
      1. If asked "Who are you?", explain that you're a hotel booking assistant chatbot.
      2. If asked "Who am I?", provide details about the user if available.
      3. If faced with inappropriate language or queries, respond ethically and professionally, redirecting the conversation to booking-related topics.
      4. Guide users through the booking process: greeting, showing rooms, asking for nights, calculating price, confirming booking, and processing payment.
      5. You can communicate in any language the user prefers.
      6. Format responses with proper line breaks for better readability, especially when listing options.
      7. Only mention payment when the user explicitly asks about it or is ready to pay.
      User details: ${JSON.stringify(user)}
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...messages
      ],
      functions: [
        {
          name: "get_rooms",
          description: "Get available hotel rooms",
          parameters: { type: "object", properties: {} }
        },
        {
          name: "book_room",
          description: "Book a hotel room",
          parameters: {
            type: "object",
            properties: {
              roomId: { type: "number" },
              fullName: { type: "string" },
              email: { type: "string" },
              nights: { type: "number" }
            },
            required: ["roomId", "fullName", "email", "nights"]
          }
        },
        {
          name: "simulate_payment",
          description: "Simulate payment process",
          parameters: {
            type: "object",
            properties: {
              amount: { type: "number" },
              method: { type: "string", enum: ["credit_card", "debit_card", "paypal"] }
            },
            required: ["amount", "method"]
          }
        }
      ],
      function_call: "auto",
    });

    let assistantMessage = completion.choices[0].message;

    if (assistantMessage.function_call) {
      const functionName = assistantMessage.function_call.name;
      const functionArgs = JSON.parse(assistantMessage.function_call.arguments);

      let functionResult;
      if (functionName === 'get_rooms') {
        functionResult = await getRooms();
      } else if (functionName === 'book_room') {
        functionResult = await bookRoom(
          functionArgs.roomId,
          functionArgs.fullName,
          functionArgs.email,
          functionArgs.nights
        );
      } else if (functionName === 'simulate_payment') {
        functionResult = simulatePayment(functionArgs.amount, functionArgs.method);
      }

      messages.push(assistantMessage);
      messages.push({
        role: "function",
        name: functionName,
        content: JSON.stringify(functionResult)
      });

      const secondCompletion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: messages
      });

      assistantMessage = secondCompletion.choices[0].message;
    }

    messages.push(assistantMessage);

    await conversation.update({ messages: JSON.stringify(messages) });

    res.json({ response: assistantMessage.content });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));